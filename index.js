const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== FIREBASE ADMIN =====
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ===== JWT VERIFICATION =====
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
  const token = authHeader.split(" ")[1];
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(403).json({ message: "Forbidden" });
  }
};

// ===== MONGODB - LAZY CONNECTION =====
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@artify.ndgtchi.mongodb.net/?retryWrites=true&w=majority&appName=Artify`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

// Global variables for collections
let usersCollection, contestsCollection, paymentsCollection;
let isConnected = false;
let scheduledJobStarted = false;

// Lazy connection function - connects on first request
async function ensureDbConnection() {
  if (isConnected && usersCollection && contestsCollection && paymentsCollection) {
    return { usersCollection, contestsCollection, paymentsCollection };
  }

  try {
    await client.connect();
    console.log("✅ MongoDB Connected (ContestHub)");
    
    usersCollection = client.db("ContestHub-db").collection("Users");
    contestsCollection = client.db("ContestHub-db").collection("Contests");
    paymentsCollection = client.db("ContestHub-db").collection("Payments");
    
    isConnected = true;
    
    // Start scheduled job only once
    if (!scheduledJobStarted) {
      startStatusUpdateJob();
      scheduledJobStarted = true;
    }
    
    return { usersCollection, contestsCollection, paymentsCollection };
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

// Middleware to ensure DB is connected before each request
const ensureDb = async (req, res, next) => {
  try {
    await ensureDbConnection();
    next();
  } catch (error) {
    console.error("Database initialization failed:", error);
    res.status(500).json({ message: "Database initialization failed" });
  }
};

// Apply DB middleware to all routes that need database access
app.use("/users", ensureDb);
app.use("/contests", ensureDb);
app.use("/leaderboard", ensureDb);
app.use("/top-creators", ensureDb);
app.use("/upcoming", ensureDb);
app.use("/participated-contests", ensureDb);
app.use("/winning-contests", ensureDb);
app.use("/admin", ensureDb);
app.use("/create-checkout-session", ensureDb);
app.use("/payments", ensureDb);
app.use("/stats", ensureDb);
app.use("/contests/winners", ensureDb);
app.use("/Allcontests", ensureDb);
app.use("/contests/popular", ensureDb);
app.use("/contests/search", ensureDb);

// ===== ROLE MIDDLEWARE (requires DB) =====
const verifyAdmin = async (req, res, next) => {
  await ensureDbConnection();
  const user = await usersCollection.findOne({ email: req.user.email });
  if (!user || user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
  next();
};

const verifyCreator = async (req, res, next) => {
  await ensureDbConnection();
  const user = await usersCollection.findOne({ email: req.user.email });
  if (!user || user.role !== "creator") return res.status(403).json({ message: "Creator access required" });
  next();
};

// ===== SCHEDULED JOB TO UPDATE CONTEST STATUSES =====
const updateExpiredContests = async () => {
  try {
    if (!isConnected) return;
    
    const now = new Date();
    const result = await contestsCollection.updateMany(
      {
        deadline: { $lt: now },
        status: { $ne: "completed" },
        winnerEmail: null
      },
      {
        $set: {
          status: "completed",
          updatedAt: now
        }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`Updated ${result.modifiedCount} expired contests to completed status`);
    }
  } catch (error) {
    console.error("Error updating expired contests:", error);
  }
};

const startStatusUpdateJob = () => {
  updateExpiredContests();
  cron.schedule('0 * * * *', () => {
    console.log('Running scheduled contest status update...');
    updateExpiredContests();
  });
};

// ===== USERS =====
app.post("/users", async (req, res) => {
  await ensureDbConnection();
  const { email } = req.body;
  if (await usersCollection.findOne({ email })) return res.send({ message: "User already exists" });
  const newUser = { ...req.body, role: "user", createdAt: new Date() };
  const result = await usersCollection.insertOne(newUser);
  res.send(result);
});

app.get("/users/:email", async (req, res) => {
  await ensureDbConnection();
  const user = await usersCollection.findOne({ email: req.params.email });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(user);
});

app.put("/users/:email", verifyToken, async (req, res) => {
  await ensureDbConnection();
  if (req.user.email !== req.params.email) return res.status(403).json({ message: "Cannot update other user's profile" });
  const updateDoc = { $set: { ...req.body, updatedAt: new Date() } };
  const result = await usersCollection.updateOne({ email: req.params.email }, updateDoc);
  res.send(result);
});

// ===== CONTESTS =====
app.post("/contests", verifyToken, verifyCreator, async (req, res) => {
  await ensureDbConnection();
  const { title, deadline, prizeMoney } = req.body;
  if (!title || !deadline) return res.status(400).json({ message: "Title and deadline are required" });

  let parsedPrizeMoney = 0;
  if (prizeMoney !== undefined && prizeMoney !== null) {
    if (typeof prizeMoney === 'string') {
      parsedPrizeMoney = parseFloat(prizeMoney);
    } else if (typeof prizeMoney === 'number') {
      parsedPrizeMoney = prizeMoney;
    }
  }
  if (isNaN(parsedPrizeMoney)) parsedPrizeMoney = 0;

  const newContest = {
    ...req.body,
    prizeMoney: parsedPrizeMoney,
    creatorEmail: req.user.email,
    creatorName: req.user.name || "Unknown",
    status: "pending",
    participants: [],
    submissions: [],
    winnerEmail: null,
    winnerName: null,
    winnerImage: null,
    createdAt: new Date(),
  };
  const result = await contestsCollection.insertOne(newContest);
  res.send(result);
});

app.get("/contests", async (req, res) => {
  await ensureDbConnection();
  const contests = await contestsCollection.find({ status: "approved" }).sort({ createdAt: -1 }).toArray();
  res.send(contests);
});

app.get("/Allcontests", async (req, res) => {
  await ensureDbConnection();
  const contests = await contestsCollection.find().sort({ createdAt: -1 }).toArray();
  res.send(contests);
});

app.get("/contests/popular", async (req, res) => {
  try {
    await ensureDbConnection();
    const contests = await contestsCollection.aggregate([
      { $match: { status: "approved" } },
      { $addFields: { participantCount: { $size: "$participants" } } },
      { $sort: { participantCount: -1 } },
      { $limit: 5 }
    ]).toArray();
    res.send(contests);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch popular contests" });
  }
});

app.get("/contests/winners", async (req, res) => {
  await ensureDbConnection();
  const winners = await contestsCollection
    .find({ winnerEmail: { $ne: null } })
    .sort({ updatedAt: -1 })
    .limit(6)
    .project({
      title: 1,
      prizeMoney: 1,
      winnerName: 1,
      winnerImage: 1,
      image: 1,
    })
    .toArray();
  res.send(winners);
});

app.get("/contests/search", async (req, res) => {
  await ensureDbConnection();
  const { type } = req.query;
  const contests = await contestsCollection.find({ status: "approved", contestType: { $regex: type, $options: "i" } }).toArray();
  res.send(contests);
});

app.get("/contests/:id", async (req, res) => {
  await ensureDbConnection();
  const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
  res.send(contest);
});

app.patch("/contests/:id/status", verifyToken, async (req, res) => {
  try {
    await ensureDbConnection();
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'approved', 'rejected', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const contest = await contestsCollection.findOne({ _id: new ObjectId(id) });
    if (!contest) {
      return res.status(404).json({ error: 'Contest not found' });
    }

    const isCreator = contest.creatorEmail === req.user.email;
    const user = await usersCollection.findOne({ email: req.user.email });
    const isAdmin = user?.role === "admin";

    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to update contest status' });
    }

    const updatedContest = await contestsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    res.json(updatedContest.value);
  } catch (error) {
    console.error("Status update failed:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/contests/creator/:email", verifyToken, verifyCreator, async (req, res) => {
  await ensureDbConnection();
  const contests = await contestsCollection.find({ creatorEmail: req.params.email }).sort({ createdAt: -1 }).toArray();
  res.send(contests);
});

app.patch("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
  await ensureDbConnection();
  const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });
  if (contest.creatorEmail !== req.user.email) return res.status(403).json({ message: "Not your contest" });
  if (contest.status !== "pending") return res.status(400).json({ message: "Only pending contests can be edited" });

  const updateData = { ...req.body };
  if (updateData.prizeMoney !== undefined) {
    if (typeof updateData.prizeMoney === 'string') {
      updateData.prizeMoney = parseFloat(updateData.prizeMoney);
    }
    if (isNaN(updateData.prizeMoney)) updateData.prizeMoney = 0;
  }

  const updateDoc = { $set: { ...updateData, updatedAt: new Date() } };
  const result = await contestsCollection.updateOne({ _id: new ObjectId(req.params.id) }, updateDoc);
  res.send(result);
});

app.delete("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
  await ensureDbConnection();
  const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });
  if (contest.creatorEmail !== req.user.email) return res.status(403).json({ message: "Not your contest" });
  if (contest.status !== "pending") return res.status(400).json({ message: "Only pending contests can be deleted" });

  const result = await contestsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
  res.send(result);
});

app.patch("/contests/declare-winner/:id", verifyToken, verifyCreator, async (req, res) => {
  await ensureDbConnection();
  const contestId = req.params.id;
  const { winnerEmail } = req.body;

  if (!winnerEmail) return res.status(400).json({ message: "Winner email is required" });

  const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });

  if (contest.creatorEmail !== req.user.email)
    return res.status(403).json({ message: "Only the contest creator can declare winner" });

  const participantEmails = contest.participants.map(p => (typeof p === "string" ? p : p.email));
  if (!participantEmails.includes(winnerEmail))
    return res.status(400).json({ message: "Winner must be a participant" });

  const winnerUser = await usersCollection.findOne({ email: winnerEmail });

  const winnerName = winnerUser?.name || contest.submissions.find(s => s.email === winnerEmail)?.name || "Unknown";
  const winnerImage = winnerUser?.photoURL || contest.submissions.find(s => s.email === winnerEmail)?.image || null;

  await contestsCollection.updateOne(
    { _id: new ObjectId(contestId) },
    {
      $set: {
        winnerEmail,
        winnerName,
        winnerImage,
        status: "completed",
        updatedAt: new Date(),
      },
    }
  );

  res.json({ success: true, message: "Winner declared successfully", winnerEmail, winnerName, winnerImage });
});

// ===== LEADERBOARD =====
app.get("/leaderboard", async (req, res) => {
  try {
    await ensureDbConnection();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const contestsWithWinners = await contestsCollection
      .find({ winnerEmail: { $ne: null } })
      .project({ winnerEmail: 1 })
      .toArray();

    const winCountMap = {};
    contestsWithWinners.forEach(contest => {
      const winner = contest.winnerEmail;
      if (winner) winCountMap[winner] = (winCountMap[winner] || 0) + 1;
    });

    const winnerEmails = Object.keys(winCountMap);
    const users = await usersCollection
      .find({ email: { $in: winnerEmails } })
      .project({ name: 1, email: 1, photoURL: 1 })
      .toArray();

    const leaderboard = users
      .map(user => ({
        name: user.name || "Unknown",
        email: user.email,
        photoURL: user.photoURL || null,
        wins: winCountMap[user.email] || 0,
      }))
      .sort((a, b) => b.wins - a.wins);

    const paginatedLeaderboard = leaderboard.slice(skip, skip + limit);

    res.json({
      page,
      totalPages: Math.ceil(leaderboard.length / limit),
      totalUsers: leaderboard.length,
      data: paginatedLeaderboard,
    });
  } catch (error) {
    console.error("Leaderboard fetch failed:", error);
    res.status(500).json({ message: "Failed to fetch leaderboard" });
  }
});

app.get("/top-creators", async (req, res) => {
  try {
    await ensureDbConnection();
    const allContests = await contestsCollection.find().project({ creatorEmail: 1, creatorName: 1 }).toArray();

    const creatorCountMap = {};
    allContests.forEach(contest => {
      if (!contest.creatorEmail) return;
      if (!creatorCountMap[contest.creatorEmail]) {
        creatorCountMap[contest.creatorEmail] = { name: contest.creatorName || "Unknown", email: contest.creatorEmail, count: 1 };
      } else {
        creatorCountMap[contest.creatorEmail].count += 1;
      }
    });

    const topCreators = Object.values(creatorCountMap).sort((a, b) => b.count - a.count);
    const emails = topCreators.map(c => c.email);
    const users = await usersCollection.find({ email: { $in: emails } }).project({ email: 1, photoURL: 1 }).toArray();
    const usersMap = {};
    users.forEach(u => { usersMap[u.email] = u.photoURL || null });

    const result = topCreators.map(c => ({ ...c, photoURL: usersMap[c.email] || null }));
    res.json(result);
  } catch (error) {
    console.error("Top creators fetch failed:", error);
    res.status(500).json({ message: "Failed to fetch top creators" });
  }
});

app.get("/upcoming", async (req, res) => {
  try {
    await ensureDbConnection();
    const upcomingContests = await contestsCollection
      .find({ status: "pending" })
      .sort({ createdAt: -1 })
      .project({
        image: 1,
        title: 1,
        creatorName: 1,
        creatorEmail: 1,
        deadline: 1,
        prizeMoney: 1,
      })
      .toArray();
    res.json(upcomingContests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch upcoming contests" });
  }
});

app.patch("/contests/register/:id", verifyToken, async (req, res) => {
  await ensureDbConnection();
  const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });

  if (contest.status === "completed") {
    return res.status(400).json({ message: "Cannot register for completed contest" });
  }

  const participantEmails = contest.participants.map(p => typeof p === "string" ? p : p.email);

  if (participantEmails.includes(req.user.email)) return res.status(400).json({ message: "Already registered" });

  await contestsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $push: { participants: { email: req.user.email } } }
  );
  res.send({ message: "Registration successful" });
});

app.post("/contests/:id/submit-task", verifyToken, async (req, res) => {
  await ensureDbConnection();
  const { taskLink } = req.body;
  if (!taskLink) return res.status(400).json({ message: "Task link is required" });

  const contestId = req.params.id;
  const userEmail = req.user.email;
  const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });

  if (contest.status === "completed") {
    return res.status(400).json({ message: "Cannot submit task for completed contest" });
  }

  const participant = contest.participants.find(
    (p) => (typeof p === "string" ? p === userEmail : p.email === userEmail)
  );

  if (!participant) return res.status(403).json({ message: "You are not registered for this contest" });

  const alreadySubmitted = contest.submissions.find((s) => s.email === userEmail);
  if (alreadySubmitted) return res.status(400).json({ message: "You have already submitted your task" });

  const submission = {
    email: userEmail,
    name: req.user.name || "Unknown",
    image: req.user.photoURL,
    taskLink,
    submittedAt: new Date(),
  };

  await contestsCollection.updateOne(
    { _id: new ObjectId(contestId) },
    { $push: { submissions: submission } }
  );

  res.json({ message: "Task submitted successfully", submission });
});

app.get("/contests/submissions/:id", verifyToken, verifyCreator, async (req, res) => {
  await ensureDbConnection();
  const contestId = req.params.id;
  const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });
  res.json(contest.submissions || []);
});

app.get("/participated-contests/:email", verifyToken, async (req, res) => {
  await ensureDbConnection();
  if (req.user.email !== req.params.email) return res.status(403).json({ message: "Forbidden" });
  const contests = await contestsCollection.find({ "participants.email": req.params.email }).toArray();
  res.send(contests);
});

app.get("/winning-contests/:email", verifyToken, async (req, res) => {
  await ensureDbConnection();
  const contests = await contestsCollection.find({ winnerEmail: req.params.email }).toArray();
  res.send(contests);
});

app.get("/admin/contests", verifyToken, verifyAdmin, async (req, res) => {
  await ensureDbConnection();
  const contests = await contestsCollection.find().sort({ createdAt: -1 }).toArray();
  res.send(contests);
});

app.patch("/admin/contests/:id", verifyToken, verifyAdmin, async (req, res) => {
  await ensureDbConnection();
  const result = await contestsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: req.body.status, updatedAt: new Date() } }
  );
  res.send(result);
});

app.delete("/admin/contests/:id", verifyToken, verifyAdmin, async (req, res) => {
  await ensureDbConnection();
  const result = await contestsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
  res.send(result);
});

app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  await ensureDbConnection();
  const users = await usersCollection.find().toArray();
  res.send(users);
});

app.patch("/admin/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
  await ensureDbConnection();
  const result = await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } });
  res.send(result);
});

app.get("/stats", async (req, res) => {
  try {
    await ensureDbConnection();
    const allContests = await contestsCollection.find({ status: "approved" }).toArray();

    const totalParticipants = allContests.reduce((sum, contest) => {
      return sum + (contest.participants?.length || 0);
    }, 0);

    const totalPrizeMoney = allContests.reduce((sum, contest) => {
      let prize = 0;
      if (contest.prizeMoney !== undefined && contest.prizeMoney !== null) {
        if (typeof contest.prizeMoney === 'number') {
          prize = contest.prizeMoney;
        } else if (typeof contest.prizeMoney === 'string') {
          prize = parseFloat(contest.prizeMoney);
        }
      }
      return sum + (isNaN(prize) ? 0 : prize);
    }, 0);

    const completedContests = allContests.filter((contest) => {
      if (!contest.deadline) return false;
      const deadline = new Date(contest.deadline);
      return !Number.isNaN(deadline.getTime()) && deadline <= new Date();
    }).length;

    res.json({
      activeContests: allContests.length,
      totalParticipants,
      totalPrizeMoney,
      completedContests
    });
  } catch (error) {
    console.error("Stats fetch failed:", error);
    res.status(500).json({ message: "Failed to fetch statistics" });
  }
});

app.post("/create-checkout-session", verifyToken, async (req, res) => {
  await ensureDbConnection();
  const contest = await contestsCollection.findOne({ _id: new ObjectId(req.body.contestId) });
  if (!contest) return res.status(404).json({ message: "Contest not found" });

  if (contest.status === "completed") {
    return res.status(400).json({ message: "Cannot register for completed contest" });
  }

  const participantEmails = contest.participants.map(p => typeof p === "string" ? p : p.email);
  if (participantEmails.includes(req.user.email)) return res.status(400).json({ message: "Already registered" });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: contest.title },
          unit_amount: contest.price * 100,
        },
        quantity: 1,
      },
    ],
    metadata: { contestId: contest._id.toString(), userEmail: req.user.email },
    success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&contestId=${contest._id}`,
    cancel_url: `${process.env.CLIENT_URL}/contest/${contest._id}`,
  });

  await paymentsCollection.updateOne(
    { sessionId: session.id },
    {
      $setOnInsert: {
        userEmail: req.user.email,
        contestId: contest._id,
        sessionId: session.id,
        amount: contest.price,
        status: "pending",
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  res.json({ url: session.url });
});

app.post("/payments/confirm", async (req, res) => {
  await ensureDbConnection();
  const { sessionId } = req.body;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== "paid") return res.status(400).json({ message: "Payment not completed" });

    const contestId = session.metadata.contestId;
    const userEmail = session.metadata.userEmail;

    const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
    if (!contest) return res.status(404).json({ message: "Contest not found" });

    if (contest.status === "completed") {
      return res.status(400).json({ message: "Cannot register for completed contest" });
    }

    const participantEmails = contest.participants.map(p => typeof p === "string" ? p : p.email);

    if (!participantEmails.includes(userEmail)) {
      await contestsCollection.updateOne(
        { _id: new ObjectId(contestId) },
        {
          $push: {
            participants: {
              email: userEmail,
              paymentStatus: "paid",
              paymentIntentId: session.payment_intent,
              paidAt: new Date(),
            },
          },
        }
      );
    }

    await paymentsCollection.updateOne(
      { sessionId },
      {
        $set: {
          status: "paid",
          paymentIntentId: session.payment_intent,
          paidAt: new Date(),
        },
      }
    );

    res.json({ success: true, message: "Payment successful! You are registered." });
  } catch (error) {
    console.error("Payment verification failed:", error);
    res.status(500).json({ message: "Payment verification failed" });
  }
});

// ===== HEALTH CHECK ENDPOINT =====
app.get("/health", (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), dbConnected: isConnected });
});

// ===== TEST ROUTE =====
app.get("/", (req, res) => res.send("ContestHub Server Running"));

// ===== SERVER START (conditional for Vercel) =====
if (require.main === module) {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;