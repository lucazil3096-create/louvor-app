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
                      tag: "chat-" + (lastMsg.ts || Date.now()),
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
                    tag: "escala-" + Date.now(),
                  }),
              );
            }
          }
        }
      } catch (e) {
        console.error("Escala notification error:", e);
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
  const message = {
    notification: {
      title: data.title,
      body: data.body,
    },
    data: {
      tag: uniqueTag,
      title: data.title,
      body: data.body,
    },
    webpush: {
      notification: {
        icon: "/icon-192x192.png",
        badge: "/icon-192x192.png",
        vibrate: [200, 100, 200],
        tag: uniqueTag,
        requireInteraction: false,
      },
      fcmOptions: {
        link: "/",
      },
    },
  };

  const response = await messaging.sendEachForMulticast({
    tokens: tokens,
    ...message,
  });

  // Clean up invalid tokens
  if (response.failureCount > 0) {
    const tokensDoc = await db.collection("app").doc("fcm-tokens").get();
    if (tokensDoc.exists) {
      const tokensMap = tokensDoc.data().tokens || {};
      let changed = false;
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error ? resp.error.code : "";
          if (
            code === "messaging/invalid-registration-token" ||
            code === "messaging/registration-token-not-registered"
          ) {
            // Find and remove this token
            const badToken = tokens[idx];
            for (const [name, val] of Object.entries(tokensMap)) {
              if (val.token === badToken) {
                delete tokensMap[name];
                changed = true;
                console.log("Removed invalid token for:", name);
              }
            }
          }
        }
      });
      if (changed) {
        await db.collection("app").doc("fcm-tokens").set({tokens: tokensMap});
      }
    }
  }

  console.log(
      "Notifications sent:",
      response.successCount,
      "ok,",
      response.failureCount,
      "failed",
  );
}
