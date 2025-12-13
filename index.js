const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

const { MongoClient, ServerApiVersion } = require("mongodb");

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

      res.send(user);
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
