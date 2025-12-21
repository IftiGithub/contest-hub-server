const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 3000;

// ===== FIREBASE ADMIN =====
const serviceAccount = require("./contest-hub-485e5-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

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

// ===== ROLE MIDDLEWARE =====
let usersCollection, contestsCollection, paymentsCollection;

const verifyAdmin = async (req, res, next) => {
  const user = await usersCollection.findOne({ email: req.user.email });
  if (!user || user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
  next();
};

const verifyCreator = async (req, res, next) => {
  const user = await usersCollection.findOne({ email: req.user.email });
  if (!user || user.role !== "creator") return res.status(403).json({ message: "Creator access required" });
  next();
};

// ===== MONGODB =====
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@artify.ndgtchi.mongodb.net/?retryWrites=true&w=majority&appName=Artify`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected");

    usersCollection = client.db("ContestHub-db").collection("Users");
    contestsCollection = client.db("ContestHub-db").collection("Contests");
    paymentsCollection = client.db("ContestHub-db").collection("Payments");

    // ===== USERS =====
    app.post("/users", async (req, res) => {
      const { email } = req.body;
      if (await usersCollection.findOne({ email })) return res.send({ message: "User already exists" });
      const newUser = { ...req.body, role: "user", createdAt: new Date() };
      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    app.get("/users/:email", async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    });

    app.put("/users/:email", verifyToken, async (req, res) => {
      if (req.user.email !== req.params.email) return res.status(403).json({ message: "Cannot update other user's profile" });
      const updateDoc = { $set: { ...req.body, updatedAt: new Date() } };
      const result = await usersCollection.updateOne({ email: req.params.email }, updateDoc);
      res.send(result);
    });

    // ===== CONTESTS =====
    app.post("/contests", verifyToken, verifyCreator, async (req, res) => {
      const { title, deadline } = req.body;
      if (!title || !deadline) return res.status(400).json({ message: "Title and deadline are required" });

      const newContest = {
        ...req.body,
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
      const contests = await contestsCollection.find({ status: "approved" }).sort({ createdAt: -1 }).toArray();
      res.send(contests);
    });

    app.get("/contests/popular", async (req, res) => {
      const contests = await contestsCollection.find({ status: "approved" }).sort({ "participants.length": -1 }).limit(5).toArray();
      res.send(contests);
    });

    app.get("/contests/search", async (req, res) => {
      const { type } = req.query;
      const contests = await contestsCollection.find({ status: "approved", contestType: { $regex: type, $options: "i" } }).toArray();
      res.send(contests);
    });

    app.get("/contests/:id", async (req, res) => {
      const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
      res.send(contest);
    });

    app.get("/contests/creator/:email", verifyToken, verifyCreator, async (req, res) => {
      const contests = await contestsCollection.find({ creatorEmail: req.params.email }).sort({ createdAt: -1 }).toArray();
      res.send(contests);
    });

    app.patch("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
      const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });
      if (contest.creatorEmail !== req.user.email) return res.status(403).json({ message: "Not your contest" });
      if (contest.status !== "pending") return res.status(400).json({ message: "Only pending contests can be edited" });

      const updateDoc = { $set: { ...req.body, updatedAt: new Date() } };
      const result = await contestsCollection.updateOne({ _id: new ObjectId(req.params.id) }, updateDoc);
      res.send(result);
    });

    app.delete("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
      const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });
      if (contest.creatorEmail !== req.user.email) return res.status(403).json({ message: "Not your contest" });
      if (contest.status !== "pending") return res.status(400).json({ message: "Only pending contests can be deleted" });

      const result = await contestsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });
    // ===== DECLARE WINNER =====
    app.patch("/contests/declare-winner/:id", verifyToken, verifyCreator, async (req, res) => {
      const contestId = req.params.id;
      const { winnerEmail } = req.body;

      if (!winnerEmail) return res.status(400).json({ message: "Winner email is required" });

      const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });

      // Only contest creator can declare winner
      if (contest.creatorEmail !== req.user.email)
        return res.status(403).json({ message: "Only the contest creator can declare winner" });

      // Check if winner is a participant
      const participantEmails = contest.participants.map(p => (typeof p === "string" ? p : p.email));
      if (!participantEmails.includes(winnerEmail))
        return res.status(400).json({ message: "Winner must be a participant" });
      const winnerUser = await usersCollection.findOne({ email: winnerEmail });

      const winnerName =
        winnerUser?.name ||
        contest.submissions.find(s => s.email === winnerEmail)?.name ||
        "Unknown";

      const winnerImage =
        winnerUser?.photoURL ||
        contest.submissions.find(s => s.email === winnerEmail)?.image ||
        null;


      await contestsCollection.updateOne(
        { _id: new ObjectId(contestId) },
        {
          $set: {
            winnerEmail,
            winnerName,
            winnerImage,
            updatedAt: new Date(),
          },
        }
      );


      res.json({ success: true, message: "Winner declared successfully", winnerEmail, winnerName, winnerImage });
    });


    // ===== REGISTER TO CONTEST =====
    app.patch("/contests/register/:id", verifyToken, async (req, res) => {
      const contest = await contestsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });

      const participantEmails = contest.participants.map(p => typeof p === "string" ? p : p.email);

      if (participantEmails.includes(req.user.email)) return res.status(400).json({ message: "Already registered" });

      await contestsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $push: { participants: { email: req.user.email } } }
      );
      res.send({ message: "Registration successful" });
    });
    // ===== SUBMIT TASK =====
    app.post("/contests/:id/submit-task", verifyToken, async (req, res) => {
      const { taskLink } = req.body; // the user provides a link or description
      if (!taskLink) return res.status(400).json({ message: "Task link is required" });

      const contestId = req.params.id;
      const userEmail = req.user.email;
      const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });

      // Check if user is registered for this contest
      const participant = contest.participants.find(
        (p) => (typeof p === "string" ? p === userEmail : p.email === userEmail)
      );

      if (!participant) return res.status(403).json({ message: "You are not registered for this contest" });

      // Check if user already submitted
      const alreadySubmitted = contest.submissions.find((s) => s.email === userEmail);
      if (alreadySubmitted) return res.status(400).json({ message: "You have already submitted your task" });

      // Add submission
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
    // ===== GET SUBMISSIONS FOR A CONTEST =====
    app.get("/contests/submissions/:id", verifyToken, verifyCreator, async (req, res) => {
      const contestId = req.params.id;

      const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });

      res.json(contest.submissions || []);
    });

    // ===== PARTICIPATED CONTESTS =====
    app.get("/participated-contests/:email", verifyToken, async (req, res) => {
      if (req.user.email !== req.params.email) return res.status(403).json({ message: "Forbidden" });

      const contests = await contestsCollection.find({
        "participants.email": req.params.email
      }).toArray();

      res.send(contests);
    });

    app.get("/winning-contests/:email", verifyToken, async (req, res) => {
      const contests = await contestsCollection.find({ winnerEmail: req.params.email }).toArray();
      res.send(contests);
    });

    // ===== ADMIN =====
    app.get("/admin/contests", verifyToken, verifyAdmin, async (req, res) => {
      const contests = await contestsCollection.find().sort({ createdAt: -1 }).toArray();
      res.send(contests);
    });

    app.patch("/admin/contests/:id", verifyToken, verifyAdmin, async (req, res) => {
      const result = await contestsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status } });
      res.send(result);
    });

    app.delete("/admin/contests/:id", verifyToken, verifyAdmin, async (req, res) => {
      const result = await contestsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.patch("/admin/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } });
      res.send(result);
    });

    // ===== STRIPE CHECKOUT =====
    app.post("/create-checkout-session", verifyToken, async (req, res) => {
      const contest = await contestsCollection.findOne({ _id: new ObjectId(req.body.contestId) });
      if (!contest) return res.status(404).json({ message: "Contest not found" });

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

      // Avoid duplicate payments
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

    // ===== PAYMENT CONFIRM =====
    app.post("/payments/confirm", async (req, res) => {
      const { sessionId } = req.body;

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (!session || session.payment_status !== "paid") return res.status(400).json({ message: "Payment not completed" });

        const contestId = session.metadata.contestId;
        const userEmail = session.metadata.userEmail;

        const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
        if (!contest) return res.status(404).json({ message: "Contest not found" });

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

  } finally {
    // Keep connection alive
  }
}

run().catch(console.dir);

// ===== TEST ROUTE =====
app.get("/", (req, res) => res.send("ContestHub Server Running"));

app.listen(port, () => console.log(`Server running on port ${port}`));
