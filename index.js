import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { db, admin } from "./firebaseAdmin.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Generate UUID helper
function generateUUID() {
  return crypto.randomUUID();
}

/* ---------------------------------------------------
   PAY INIT - Creates payment with metadata for webhook
--------------------------------------------------- */
app.post("/pay", async (req, res) => {
  try {
    const { amount, phone, network, userId, itemId } = req.body;

    if (!amount || !phone || !network || !userId || !itemId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const paymentRef = generateUUID();

    console.log(`[PAY] Creating payment ${paymentRef} for user ${userId}, item ${itemId}`);

    const payResponse = await axios.post(
      "https://api.paychangu.com/payment",
      {
        amount,
        currency: "MWK",
        phone_number: phone,
        network,
        reference: paymentRef,
        callback_url: "https://paychangu-backend-g9vt.onrender.com/payment-success",

        // ✅ CRITICAL FIX: Send user data as metadata so it comes back in webhook
        meta: {
          userId: userId,
          itemId: itemId
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const checkoutUrl = payResponse?.data?.data?.checkout_url;
    if (!checkoutUrl) {
      throw new Error("Checkout URL missing from PayChangu");
    }

    // Store payment with correct user info
    await db.collection("payments").doc(paymentRef).set({
      userId,
      itemId,
      amount,
      phone,
      network,
      status: "PENDING",
      ticketCreated: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[PAY] Stored payment ${paymentRef}`);
    res.json({ paymentId: paymentRef, checkoutUrl });
  } catch (err) {
    console.error("[PAY ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------
   WEBHOOK (POST) - Reads metadata to create ticket with correct owner
--------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK] Received");

  try {
    // Optional: Verify signature
    const signature = req.headers["x-paychangu-signature"];
    const webhookSecret = process.env.PAYCHANGU_WEBHOOK_SECRET;

    if (webhookSecret && signature) {
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("[WEBHOOK] ❌ Invalid signature");
        return res.sendStatus(401);
      }
    } else if (!signature && webhookSecret) {
      console.warn("[WEBHOOK] ⚠️ No signature provided");
    }

    const payload = req.body;
    const reference = payload.tx_ref || payload.reference;
    const status = payload.status === "success" ? "SUCCESS" : "FAILED";

    console.log(`[WEBHOOK] Ref: ${reference}, Status: ${status}`);

    if (!reference) {
      console.error("[WEBHOOK] ❌ Missing reference");
      return res.sendStatus(400);
    }

    // ✅ CRITICAL FIX: Get userId and itemId from metadata (payload.meta)
    // PayChangu sends back the meta object we sent in /pay
    const userId = payload.meta?.userId;
    const itemId = payload.meta?.itemId;

    if (!userId || !itemId) {
      console.error("[WEBHOOK] ❌ Missing userId or itemId in metadata:", payload.meta);
      return res.sendStatus(400); // Reject if we can't identify the user
    }

    // Check if payment document exists (it should, created by /pay)
    const paymentDocRef = db.collection("payments").doc(reference);
    const paymentSnap = await paymentDocRef.get();

    if (!paymentSnap.exists) {
      console.error(`[WEBHOOK] ❌ Payment ${reference} not found in DB`);
      // Still create it if webhook arrives before DB write completes
      await paymentDocRef.set({
        userId,
        itemId,
        amount: payload.amount || 0,
        status: "PENDING",
        ticketCreated: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Use transaction to prevent duplicates
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(paymentDocRef);
      const payment = snap.data();

      if (!payment) {
        console.error("[WEBHOOK] Payment data missing");
        return;
      }

      // Prevent double processing
      if (payment.ticketCreated) {
        console.log(`[WEBHOOK] ℹ️ Already processed: ${reference}`);
        return;
      }

      // Update payment status
      transaction.update(paymentDocRef, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (status === "SUCCESS") {
        // Parse itemId (format: "eventId_ticketTypeId")
        const [eventId, ticketTypeId] = itemId.split("_");

        if (!eventId || !ticketTypeId) {
          console.error("[WEBHOOK] ❌ Invalid itemId format:", itemId);
          return;
        }

        const ticketId = `TICKET_${reference}`;

        // Create ticket with CORRECT userId from metadata
        transaction.set(db.collection("tickets").doc(ticketId), {
          id: ticketId,
          userId: userId,  // ✅ This will now be the real Firebase UID
          eventId: eventId,
          ticketTypeId: ticketTypeId,
          paymentId: reference,
          status: "active",
          qrCode: ticketId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.update(paymentDocRef, { ticketCreated: true });
        console.log(`[WEBHOOK] ✅ Ticket created: ${ticketId} for user ${userId}`);
      }
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    res.sendStatus(500);
  }
});

/* ---------------------------------------------------
   PAYMENT SUCCESS (GET) - User redirect page
--------------------------------------------------- */
app.get("/payment-success", async (req, res) => {
  const reference = req.query.reference || req.query.tx_ref;

  if (!reference) {
    return res.status(400).send("<h2>❌ Invalid reference</h2>");
  }

  try {
    const snap = await db.collection("payments").doc(reference).get();
    const payment = snap.data();

    if (payment?.status === "SUCCESS" || payment?.ticketCreated) {
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="3;url=https://paychangu-backend-g9vt.onrender.com/payment-status/${reference}">
          </head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
            <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <div style="font-size: 60px; color: #4caf50; margin-bottom: 20px;">✓</div>
              <h2 style="color: #4caf50; margin-top: 0;">Payment Successful!</h2>
              <p style="color: #666;">Your ticket has been generated.</p>
              <p style="color: #999; font-size: 14px;">Ref: ${reference}</p>
            </div>
          </body>
        </html>
      `);
    } else {
      res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="3">
          </head>
          <body style="text-align: center; padding: 50px;">
            <h2>⏳ Processing...</h2>
            <p>Checking payment status...</p>
            <p style="color: #999;">Ref: ${reference}</p>
          </body>
        </html>
      `);
    }
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

/* ---------------------------------------------------
   STATUS CHECK (for app polling)
--------------------------------------------------- */
app.get("/payment-status/:id", async (req, res) => {
  try {
    const snap = await db.collection("payments").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "Not found" });
    res.json(snap.data());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});