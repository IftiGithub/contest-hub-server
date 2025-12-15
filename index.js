const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;


// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== MONGODB =====
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@artify.ndgtchi.mongodb.net/?retryWrites=true&w=majority&appName=Artify`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");

    const usersCollection = client
      .db("ContestHub-db")
      .collection("Users");

    const contestsCollection = client
      .db("ContestHub-db")
      .collection("Contests");

    // ===== CREATE USER =====
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

    // ===== GET USER BY EMAIL =====
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).json({ message: "User not found" }); // Return valid JSON
      }

      res.json(user);
    });

    // UPDATE USER PROFILE
    // ===== UPDATE USER PROFILE =====
    app.put("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
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
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to update user" });
      }
    });
    // GET /participated-contests/:email
    app.get("/participated-contests/:email", async (req, res) => {
      const email = req.params.email;

      try {
        // Fetch contests where this user has joined
        const contests = await client
          .db("ContestHub-db")
          .collection("Contests")
          .find({ participants: email }) // assuming participants is an array of emails
          .toArray();

        res.send(contests);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch participated contests" });
      }
    });
    // GET /winning-contests/:email
    app.get("/winning-contests/:email", async (req, res) => {
      const email = req.params.email;

      try {
        // Fetch contests where this user is declared winner
        const contests = await client
          .db("ContestHub-db")
          .collection("Contests")
          .find({ winnerEmail: email }) // assuming winnerEmail field exists
          .toArray();

        res.send(contests);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch winning contests" });
      }
    });
    // ===== CREATE CONTEST =====
    app.post("/contests", async (req, res) => {
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
    // ===== GET ALL APPROVED CONTESTS =====
    app.get("/contests", async (req, res) => {
      try {
        const contests = await contestsCollection
          .find({ status: "approved" })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(contests);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch contests" });
      }
    });

    // ===== GET CONTEST BY ID =====
    app.get("/contests/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(id),
        });

        res.send(contest);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch contest" });
      }
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
