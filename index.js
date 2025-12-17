const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Firebase Admin
const serviceAccount = require("./contest-hub-485e5-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== JWT Verification Middleware =====
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; // attach user info to request
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(403).json({ message: "Forbidden" });
  }
};

// ===== Admin Role Middleware =====
const verifyAdmin = async (req, res, next) => {
  const email = req.user.email;
  const user = await usersCollection.findOne({ email });
  if (!user || user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};
//===== Creator Role Middleware =====
const verifyCreator = async (req, res, next) => {
  const email = req.user.email;
  const user = await usersCollection.findOne({ email });

  if (!user || user.role !== "creator") {
    return res.status(403).json({ message: "Creator access required" });
  }

  next();
};


// ===== MONGODB =====
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@artify.ndgtchi.mongodb.net/?retryWrites=true&w=majority&appName=Artify`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let usersCollection;
let contestsCollection;

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");

    usersCollection = client.db("ContestHub-db").collection("Users");
    contestsCollection = client.db("ContestHub-db").collection("Contests");

    // ===== CREATE USER (open) =====
    app.post("/users", async (req, res) => {
      const user = req.body;

      const existingUser = await usersCollection.findOne({
        email: user.email,
      });

      if (existingUser) {
        return res.send({ message: "User already exists" });
      }

      const newUser = {
        name: user.name,
        email: user.email,
        photoURL: user.photoURL,
        role: "user", // default role
        createdAt: new Date(),
      };

      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    // ===== GET USER BY EMAIL (open) =====
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json(user);
    });

    // ===== UPDATE USER PROFILE (protected) =====
    app.put("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;

      if (req.user.email !== email) {
        return res.status(403).json({ message: "Cannot update other user's profile" });
      }

      const updatedData = req.body;
      const filter = { email };
      const updateDoc = {
        $set: {
          name: updatedData.name,
          photoURL: updatedData.photoURL,
          bio: updatedData.bio || "",
          updatedAt: new Date(),
        },
      };

      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // ===== PARTICIPATED CONTESTS (protected) =====
    app.get("/participated-contests/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      try {
        const contests = await contestsCollection.find({ participants: email }).toArray();
        res.send(contests);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch participated contests" });
      }
    });

    // ===== WINNING CONTESTS (protected) =====
    app.get("/winning-contests/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      try {
        const contests = await contestsCollection.find({ winnerEmail: email }).toArray();
        res.send(contests);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch winning contests" });
      }
    });

    // ===== CREATE CONTEST (protected) =====
    app.post("/contests", verifyToken, verifyCreator, async (req, res) => {
      try {
        const contest = req.body;

        const newContest = {
          title: contest.title,
          image: contest.image,
          description: contest.description,
          taskInstruction: contest.taskInstruction,
          contestType: contest.contestType,
          price: contest.price,
          prizeMoney: contest.prizeMoney,
          deadline: new Date(contest.deadline),
          creatorEmail: contest.creatorEmail,
          creatorName: contest.creatorName,
          status: "pending",
          participants: [],
          submissions: [],
          winnerEmail: null,
          winnerName: null,
          createdAt: new Date(),
        };

        const result = await contestsCollection.insertOne(newContest);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to create contest" });
      }
    });

    // ===== REGISTER USER TO CONTEST (protected) =====
    app.patch("/contests/register/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { email } = req.body;

      try {
        const contest = await contestsCollection.findOne({ _id: new ObjectId(id) });
        if (!contest) return res.status(404).send({ message: "Contest not found" });

        if (contest.participants.includes(email)) {
          return res.status(400).send({ message: "Already registered" });
        }

        const result = await contestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $push: { participants: email } }
        );

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Registration failed" });
      }
    });

    // ===== GET CONTESTS BY CREATOR (protected) =====
    app.get("/contests/creator/:email", verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      try {
        const contests = await contestsCollection.find({ creatorEmail: email }).sort({ createdAt: -1 }).toArray();
        res.send(contests);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch creator contests" });
      }
    });
    // ===== CREATOR EDIT CONTEST (only pending & own) =====
    app.patch("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
      const { id } = req.params;
      const updatedData = req.body;

      try {
        const contest = await contestsCollection.findOne({ _id: new ObjectId(id) });

        if (!contest) {
          return res.status(404).json({ message: "Contest not found" });
        }

        // 🔐 Ownership check
        if (contest.creatorEmail !== req.user.email) {
          return res.status(403).json({ message: "Not your contest" });
        }

        // 🔐 Only pending contests can be edited
        if (contest.status !== "pending") {
          return res.status(400).json({ message: "Only pending contests can be edited" });
        }

        const result = await contestsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              title: updatedData.title,
              image: updatedData.image,
              description: updatedData.description,
              taskInstruction: updatedData.taskInstruction,
              contestType: updatedData.contestType,
              price: updatedData.price,
              prizeMoney: updatedData.prizeMoney,
              deadline: new Date(updatedData.deadline),
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to update contest" });
      }
    });
    // ===== CREATOR DELETE CONTEST (only pending & own) =====
    app.delete("/contests/:id", verifyToken, verifyCreator, async (req, res) => {
      const { id } = req.params;

      try {
        const contest = await contestsCollection.findOne({ _id: new ObjectId(id) });

        if (!contest) {
          return res.status(404).json({ message: "Contest not found" });
        }

        // 🔐 Ownership check
        if (contest.creatorEmail !== req.user.email) {
          return res.status(403).json({ message: "Not your contest" });
        }

        // 🔐 Only pending contests can be deleted
        if (contest.status !== "pending") {
          return res.status(400).json({ message: "Only pending contests can be deleted" });
        }

        const result = await contestsCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to delete contest" });
      }
    });


    // ===== ADMIN ROUTES (protected + admin role) =====
    app.get("/admin/contests", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const contests = await contestsCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(contests);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch contests" });
      }
    });

    app.patch("/admin/contests/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      try {
        const result = await contestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update contest status" });
      }
    });

    app.delete("/admin/contests/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      try {
        const result = await contestsCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete contest" });
      }
    });

    // ===== ADMIN USER MANAGEMENT =====
    app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch users" });
      }
    });

    app.patch("/admin/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;
      try {
        const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role } });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update role" });
      }
    });

    // ===== PUBLIC CONTEST ROUTES =====
    app.get("/contests", async (req, res) => {
      const contests = await contestsCollection.find({ status: "approved" }).sort({ createdAt: -1 }).toArray();
      res.send(contests);
    });

    app.get("/contests/popular", async (req, res) => {
      const contests = await contestsCollection.find({ status: "approved" }).sort({ participants: -1 }).limit(5).toArray();
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

  } finally {
    // keep connection alive
  }
}
run().catch(console.dir);

// ===== TEST ROUTE =====
app.get("/", (req, res) => {
  res.send("ContestHub Server Running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
