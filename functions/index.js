const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Triggered when the main app data document changes.
 * Detects new chat messages and escala changes, sends push notifications.
 */
exports.onDataChange = functions.firestore
    .document("app/data")
    .onUpdate(async (change, context) => {
      const before = change.before.data();
      const after = change.after.data();

      // Get all FCM tokens
      const tokensDoc = await db.collection("app").doc("fcm-tokens").get();
      if (!tokensDoc.exists) return null;
      const tokensMap = tokensDoc.data().tokens || {};
      const allTokenEntries = Object.entries(tokensMap);
      if (allTokenEntries.length === 0) return null;

      const notifications = [];

      // --- CHECK CHAT CHANGES ---
      try {
        const oldChat = before.chatData ? JSON.parse(before.chatData) : [];
        const newChat = after.chatData ? JSON.parse(after.chatData) : [];

        if (newChat.length > oldChat.length) {
          // Find the newest message
          const lastMsg = newChat[newChat.length - 1];
          if (lastMsg && lastMsg.name && lastMsg.text) {
            const senderName = lastMsg.name.split(" ")[0];
            // Send to everyone except the sender
            const targets = allTokenEntries.filter(
                ([name]) => name.toLowerCase() !== lastMsg.name.toLowerCase(),
            );
            if (targets.length > 0) {
              const tokens = targets.map(([, v]) => v.token).filter(Boolean);
              if (tokens.length > 0) {
                notifications.push(
                    sendToTokens(tokens, {
                      title: senderName + " no chat",
                      body: lastMsg.text.substring(0, 100),
                      tag: "chat-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6),
                    }),
                );
              }
            }
          }
        }
      } catch (e) {
        console.error("Chat notification error:", e);
      }

      // --- CHECK ESCALA CHANGES ---
      try {
        const oldEscala = before.escalaData ?
          JSON.parse(before.escalaData) : [];
        const newEscala = after.escalaData ?
          JSON.parse(after.escalaData) : [];

        if (JSON.stringify(oldEscala) !== JSON.stringify(newEscala)) {
          // Find members affected by changes
          const affectedMembers = new Set();
          for (const esc of newEscala) {
            if (esc.membros) {
              for (const m of esc.membros) {
                affectedMembers.add(m.toLowerCase());
              }
            }
          }
          // Also check old escalas for removed members
          for (const esc of oldEscala) {
            if (esc.membros) {
              for (const m of esc.membros) {
                affectedMembers.add(m.toLowerCase());
              }
            }
          }

          if (affectedMembers.size > 0) {
            const targets = allTokenEntries.filter(
                ([name]) => affectedMembers.has(name.toLowerCase()),
            );
            const tokens = targets.map(([, v]) => v.token).filter(Boolean);
            if (tokens.length > 0) {
              notifications.push(
                  sendToTokens(tokens, {
                    title: "Escala Atualizada",
                    body: "Sua escala foi alterada. Toque para ver.",
                    tag: "escala-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6),
                  }),
              );
            }
          }
        }
      } catch (e) {
        console.error("Escala notification error:", e);
      }

      // --- CHECK ENSAIO CHANGES ---
      try {
        const oldEnsaio = before.ensaioData ?
          JSON.parse(before.ensaioData) : {g1: [], g2: []};
        const newEnsaio = after.ensaioData ?
          JSON.parse(after.ensaioData) : {g1: [], g2: []};

        const oldG1 = oldEnsaio.g1 || [];
        const newG1 = newEnsaio.g1 || [];
        const oldG2 = oldEnsaio.g2 || [];
        const newG2 = newEnsaio.g2 || [];

        // Check if songs were added (not just reordered)
        const oldCount = oldG1.length + oldG2.length;
        const newCount = newG1.length + newG2.length;
        const changed = JSON.stringify(oldEnsaio) !==
            JSON.stringify(newEnsaio);

        if (changed && newCount > 0) {
          // Get names of new songs added
          const oldNames1 = new Set(oldG1.map((s) => s.name || s.title || ""));
          const oldNames2 = new Set(oldG2.map((s) => s.name || s.title || ""));
          const newSongs1 = newG1.filter(
              (s) => !oldNames1.has(s.name || s.title || ""));
          const newSongs2 = newG2.filter(
              (s) => !oldNames2.has(s.name || s.title || ""));
          const allNew = [...newSongs1, ...newSongs2];

          let body;
          if (allNew.length > 0) {
            const names = allNew.map(
                (s) => s.name || s.title || "?").slice(0, 3);
            body = names.join(", ");
            if (allNew.length > 3) body += " +" + (allNew.length - 3);
          } else if (newCount !== oldCount) {
            body = "Músicas atualizadas no ensaio";
          } else {
            body = "Ensaio foi atualizado";
          }

          // Send to everyone
          const tokens = allTokenEntries.map(
              ([, v]) => v.token).filter(Boolean);
          if (tokens.length > 0) {
            notifications.push(
                sendToTokens(tokens, {
                  title: "Ensaio Atualizado",
                  body: body,
                  tag: "ensaio-" + Date.now() + "-" +
                    Math.random().toString(36).substr(2, 6),
                }),
            );
          }
        }
      } catch (e) {
        console.error("Ensaio notification error:", e);
      }

      return Promise.all(notifications);
    });

/**
 * Send push notification to multiple FCM tokens.
 * Cleans up invalid tokens automatically.
 */
async function sendToTokens(tokens, data) {
  if (!tokens || tokens.length === 0) return;

  const uniqueTag = (data.tag || "general") + "-" + Date.now() + "-" +
      Math.random().toString(36).substr(2, 5);

  // Send individually with send() - more reliable than sendEachForMulticast
  const results = await Promise.allSettled(tokens.map((token) => {
    return messaging.send({
      token: token,
      webpush: {
        headers: {
          Urgency: "high",
          TTL: "86400",
        },
        notification: {
          title: data.title,
          body: data.body,
          icon: "/icon-192x192.png",
          badge: "/icon-192x192.png",
          vibrate: [200, 100, 200],
          tag: uniqueTag,
          requireInteraction: false,
        },
        fcmOptions: {
          link: "/",
        },
        data: {
          tag: uniqueTag,
          title: data.title,
          body: data.body,
        },
      },
    });
  }));

  let ok = 0;
  let fail = 0;
  results.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      ok++;
      console.log("Token", idx, "sent OK:", r.value);
    } else {
      fail++;
      const err = r.reason;
      console.error("Token", idx, "failed:",
          err.code || "unknown", err.message || "");
      // Only remove permanently invalid tokens
      if (err.code === "messaging/invalid-registration-token") {
        console.log("Token", idx, "is permanently invalid, will clean up");
      }
    }
  });

  console.log("Notifications sent:", ok, "ok,", fail, "failed");
}

/**
 * HTTP function to test push notifications.
 * Call: https://<region>-louvor-app-a7264.cloudfunctions.net/testNotification
 */
exports.testNotification = functions.https.onRequest(async (req, res) => {
  try {
    const tokensDoc = await db.collection("app").doc("fcm-tokens").get();
    if (!tokensDoc.exists) {
      res.json({error: "No fcm-tokens document found"});
      return;
    }
    const tokensMap = tokensDoc.data().tokens || {};
    const entries = Object.entries(tokensMap);
    if (entries.length === 0) {
      res.json({error: "No tokens registered", tokensMap});
      return;
    }

    const allTokens = entries.map(([, v]) => v.token).filter(Boolean);
    console.log("Test: sending to", allTokens.length, "tokens");
    console.log("Registered users:", entries.map(([name]) => name));

    await sendToTokens(allTokens, {
      title: "Teste de Notificação",
      body: "Se você viu isso, as notificações estão funcionando! " +
        new Date().toLocaleTimeString("pt-BR"),
      tag: "test-" + Date.now(),
    });

    // Re-read tokens to see if any were cleaned up
    const afterDoc = await db.collection("app").doc("fcm-tokens").get();
    const afterMap = afterDoc.exists ? afterDoc.data().tokens || {} : {};

    res.json({
      success: true,
      tokensSentTo: allTokens.length,
      registeredUsers: entries.map(([name, v]) => ({
        name,
        tokenPrefix: v.token ? v.token.substring(0, 20) + "..." : "null",
        savedAt: v.ts ? new Date(v.ts).toISOString() : "unknown",
      })),
      usersAfterCleanup: Object.keys(afterMap),
    });
  } catch (e) {
    console.error("Test notification error:", e);
    res.status(500).json({error: e.message});
  }
});
