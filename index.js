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

    console.log(`[PAY] Calling PayChangu API...`, {
      amount,
      phone,
      network,
      paymentRef
    });

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

    console.log(
      `[PAY] PayChangu Response:`,
      JSON.stringify(payResponse.data, null, 2)
    );

    const checkoutUrl = payResponse.data?.data?.checkout_url;

    if (!checkoutUrl) {
      console.error("[PAY ERROR] No checkout_url!");
      throw new Error("Missing checkout_url from PayChangu");
    }

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
      checkoutUrl
    });
  } catch (error) {
    console.error("[PAY ERROR]", error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ---------------- WEBHOOK (UPGRADED – DEBUG FIRST) ---------------- */
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT 🔥");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const data = req.body?.data || {};
    const event = req.body?.event;

    // PayChangu may send reference in different fields
    const reference =
      data.reference ||
      data.tx_ref ||
      data.payment_ref ||
      req.body.reference;

    const status =
      data.status ||
      req.body.status ||
      (event && event.includes("success") ? "SUCCESS" : null);

    if (!reference) {
      console.error("[WEBHOOK] No reference found");
      return res.sendStatus(400);
    }

    if (!status) {
      console.error("[WEBHOOK] No status found");
      return res.sendStatus(400);
    }

    await db.collection("payments").doc(reference).update({
      status,
      updatedAt: new Date()
    });

    console.log(`[WEBHOOK] Payment ${reference} updated to ${status}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err.message);
    res.sendStatus(500);
  }
});

/* ---------------- STATUS CHECK ---------------- */
app.get("/payment-status/:id", async (req, res) => {
  const doc = await db.collection("payments").doc(req.params.id).get();
  if (!doc.exists) return res.sendStatus(404);
  res.json(doc.data());
});

app.listen(process.env.PORT, () => {
  console.log("Server running on port", process.env.PORT);
});
