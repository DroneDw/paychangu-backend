import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { db } from "./firebaseAdmin.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------- PAY INIT ---------------- */
app.post("/pay", async (req, res) => {
  try {
    const { amount, phone, network, userId, itemId } = req.body;

    const paymentRef = `PAY_${Date.now()}`;

    const payResponse = await axios.post(
      "https://api.paychangu.com/payment",
      {
        amount,
        currency: "MWK",
        phone_number: phone,
        network,
        reference: paymentRef,
        callback_url: "https://paychangu-backend-g9vt.onrender.com/webhook"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    await db.collection("payments").doc(paymentRef).set({
      userId,
      itemId,
      amount,
      phone,
      network,
      status: "PENDING",
      createdAt: new Date()
    });

    res.json({
      paymentId: paymentRef,
      checkoutUrl: payResponse.data.checkout_url
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- WEBHOOK ---------------- */
app.post("/webhook", async (req, res) => {
  const { reference, status } = req.body;

  if (!reference) return res.sendStatus(400);

  await db.collection("payments").doc(reference).update({
    status
  });

  res.sendStatus(200);
});

/* ---------------- STATUS CHECK ---------------- */
app.get("/payment-status/:id", async (req, res) => {
  const doc = await db.collection("payments").doc(req.params.id).get();
  if (!doc.exists) return res.sendStatus(404);
  res.json(doc.data());
});

app.listen(process.env.PORT, () =>
  console.log("Server running on port", process.env.PORT)
);
