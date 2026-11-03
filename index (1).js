// AJX Savings - mobile money (MTN / Airtel Uganda) through Flutterwave.
// Secrets live here on the server, never in index.html.
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const FLW_SECRET_KEY = defineSecret("FLW_SECRET_KEY");     // Flutterwave secret key
const FLW_WEBHOOK_HASH = defineSecret("FLW_WEBHOOK_HASH"); // the "secret hash" you set in the Flutterwave dashboard
const FLW = "https://api.flutterwave.com/v3";

// 1) Member taps "Pay now": ask Flutterwave to send a payment request to their phone.
exports.startPayment = onCall({ secrets: [FLW_SECRET_KEY], region: "us-central1" }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please log in.");
  const savingId = req.data && req.data.savingId;
  if (!savingId) throw new HttpsError("invalid-argument", "Missing request.");

  const ref = db.collection("savings").doc(savingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Request not found.");
  const s = snap.data();
  if (s.uid !== req.auth.uid) throw new HttpsError("permission-denied", "Not your request.");
  if (s.status !== "awaiting") throw new HttpsError("failed-precondition", "This request is no longer waiting for payment.");
  if (!["MTN", "AIRTEL"].includes(s.provider)) throw new HttpsError("invalid-argument", "Choose MTN or Airtel.");

  const txRef = `${savingId}_${Date.now()}`;
  const resp = await fetch(`${FLW}/charges?type=mobile_money_uganda`, {
    method: "POST",
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: s.amount,
      currency: "UGX",
      network: s.provider,            // "MTN" or "AIRTEL"
      phone_number: s.payerPhone,     // 2567XXXXXXXX
      email: `${s.phone}@ajx-savings.app`,
      fullname: s.name,
      meta: { savingId, planId: s.planId, series: s.series || "" }
    })
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok || out.status !== "success") {
    console.error("Flutterwave charge failed", out);
    throw new HttpsError("internal", out.message || "The payment could not be started.");
  }
  await ref.update({ txRef, paymentStartedAt: admin.firestore.FieldValue.serverTimestamp() });
  const redirect = out.meta && out.meta.authorization && out.meta.authorization.redirect;
  return { redirect: redirect || null };
});

// 2) Flutterwave tells us the payment finished. We re-check it with Flutterwave before trusting it.
exports.flwWebhook = onRequest({ secrets: [FLW_SECRET_KEY, FLW_WEBHOOK_HASH], region: "us-central1" }, async (req, res) => {
  if (req.get("verif-hash") !== FLW_WEBHOOK_HASH.value()) return res.status(401).send("bad hash");
  const ev = req.body || {};
  if (ev.event !== "charge.completed" || !ev.data) return res.status(200).send("ignored");

  const v = await fetch(`${FLW}/transactions/${ev.data.id}/verify`, {
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY.value()}` }
  }).then(r => r.json()).catch(() => null);
  const d = v && v.data;
  if (!d || d.status !== "successful" || d.currency !== "UGX") return res.status(200).send("not successful");

  const savingId = String(d.tx_ref || "").split("_")[0];
  const ref = db.collection("savings").doc(savingId);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return;
    const s = snap.data();
    const planSnap = await t.get(db.collection("plans").doc(s.planId));
    const pl = planSnap.exists ? planSnap.data() : {};
    const daily = pl.dailyAmount && pl.minAmount ? Math.round(Number(pl.dailyAmount) * Number(s.amount) / Number(pl.minAmount)) : 0;
    if (s.status !== "awaiting" || s.txRef !== d.tx_ref) return;   // already handled, or a different attempt
    if (Number(d.amount) < Number(s.amount)) return;               // paid less than requested
    t.update(ref, {
      status: "active",
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      releaseAt: admin.firestore.Timestamp.fromMillis(Date.now() + s.lockDays * 86400000),
      confirmedBy: "mobile-money",
      dailyAmount: daily,
      flwId: d.id
    });
  });
  res.status(200).send("ok");
});
