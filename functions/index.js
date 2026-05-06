const {onRequest} = require("firebase-functions/v2/https");
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Triggered when the main app data document changes.
 * Detects new chat messages and escala changes, sends push notifications.
 */
exports.onDataChange = onDocumentUpdated(
    {document: "app/data", region: "us-central1"},
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();

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
exports.testNotification = onRequest({region: "us-central1"}, async (req, res) => {
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

/**
 * HTTP function to fetch a cifra from cifraclub.com.br server-side.
 * Avoids CORS issues that block browser-side fetching.
 *
 * Usage:
 *   GET /fetchCifra?q=Grande+e+o+Senhor   (auto: search + first result)
 *   GET /fetchCifra?url=https://www.cifraclub.com.br/morada/grande-e-o-senhor/
 * Returns JSON: { cifra, tom, url, title }
 */
exports.fetchCifra = onRequest({cors: true, region: "us-central1"}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET");
  if (req.method === "OPTIONS") return res.status(204).send("");

  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  async function fetchHtml(url) {
    const r = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " ao buscar " + url);
    return await r.text();
  }

  function findFirstResult(html) {
    const skip = new Set([
      "artistas", "generos", "pesquisa", "contato", "dicionario",
      "noticias", "cifras-mais-tocadas", "top", "cursos", "rec",
      "letras", "tablaturas",
    ]);
    const re = /https?:\/\/(?:www\.)?cifraclub\.com\.br\/([^\/?#"\s]+)\/([^\/?#"\s]+)\/?(?=["'\s])/gi;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
      const first = m[1];
      const path = m[1] + "/" + m[2];
      if (skip.has(first)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      return "https://www.cifraclub.com.br/" + path + "/";
    }
    return null;
  }

  function extractCifra(html) {
    // Look for <pre ...>...</pre> after the cifra section
    let m = html.match(
        /<pre[^>]*(?:class="cifra_cnt"|id="cifra_cnt")[^>]*>([\s\S]*?)<\/pre>/i,
    );
    if (!m) m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!m) return null;
    let raw = m[1];
    // Strip HTML tags but keep text content
    raw = raw
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return raw;
  }

  function extractTom(html) {
    // Try multiple patterns
    const patterns = [
      /Tom\s*:?\s*<\/span>\s*<a[^>]*>\s*<b[^>]*>([A-G][#bm]{0,3})<\/b>/i,
      /Tom\s*:?\s*<\/[a-z]+>\s*<[a-z]+[^>]*>\s*([A-G][#bm]{0,3})/i,
      /id="cifra_tom"[^>]*>\s*<a[^>]*>\s*([A-G][#bm]{0,3})/i,
      /class="cifra_tom"[^>]*>[^<]*<[^>]*>\s*([A-G][#bm]{0,3})/i,
      /Tom\s*:?\s*<[^>]+>\s*([A-G][#bm]{0,3})/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  }

  function extractTitle(html) {
    const m = html.match(/<title>([^<]+)<\/title>/i);
    return m ? m[1].replace(/\s*-\s*Cifra Club\s*$/i, "").trim() : null;
  }

  try {
    const q = (req.query.q || "").toString().trim();
    let url = (req.query.url || "").toString().trim();

    if (!q && !url) {
      return res.status(400).json({error: "Pass ?q=titulo or ?url=..."});
    }

    if (!url && q) {
      const searchURL =
          "https://www.cifraclub.com.br/?q=" + encodeURIComponent(q);
      const searchHtml = await fetchHtml(searchURL);
      url = findFirstResult(searchHtml);
      if (!url) {
        return res.json({error: "Nenhum resultado encontrado para: " + q});
      }
    }

    if (!/^https?:\/\/(www\.)?cifraclub\.com\.br\//i.test(url)) {
      return res.status(400).json({error: "URL deve ser de cifraclub.com.br"});
    }

    const html = await fetchHtml(url);
    const cifra = extractCifra(html);
    if (!cifra || cifra.length < 20) {
      return res.json({error: "Cifra nao encontrada na pagina.", url});
    }
    const tom = extractTom(html);
    const title = extractTitle(html);
    res.json({cifra, tom, url, title});
  } catch (e) {
    console.error("fetchCifra error:", e);
    res.status(500).json({error: e.message});
  }
});
