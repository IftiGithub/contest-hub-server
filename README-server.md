
---

## **Server-Side README (`README-server.md`)**

```markdown
# ContestHub - Server Side

## Project Overview
The backend of ContestHub provides REST APIs for contests, users, and admin functionalities. It uses **Node.js**, **Express**, and **MongoDB**. Firebase authentication is used for securing routes.

## Features
- User APIs:
  - Create and save users
  - Update user profile
  - Fetch user by email
  - Get all users (admin)
  - Update user roles (admin)
- Contest APIs:
  - Get all contests
  - Get popular contests (top 5 by participants)
  - Get upcoming contests (pending approval)
  - Create contests (creator)
  - Update contest (creator)
  - Delete contest (creator/admin)
  - Approve/reject contests (admin)
  - Submit task for contest
  - Declare winner (creator)
  - Fetch recent winners
  - Search contests by type
- Auth verification using Firebase tokens

## Tech Stack
- Node.js
- Express.js
- MongoDB (with native driver)
- Firebase Admin SDK (verify JWT)
- Stripe (for payment integration)
- CORS
- dotenv (for environment variables)