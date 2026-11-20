const DEFAULT_SETTINGS = {
  lockLink: true,
  lockMention: false,
  lockForward: true,
  lockStickerGif: false,
  lockMedia: false,
  lockBots: true,
  antiFlood: true,
  cleanService: true,
  welcomeEnabled: true,
  autoDeleteBotMsgs: true,
  aiModeration: true,
  aiChat: true,
  nightLockEnabled: false,
  nightStart: "00:00",
  nightEnd: "08:00",
  nightIsLocked: false,
  welcomeText: "سلام {name} عزیز! به گروه خوش اومدی.\nلطفاً برای دیدن مقررات گروه، کلمه «قوانین» را بفرست.",
  rulesText: "۱. احترام به تمام اعضا الزامی است.\n۲. ارسال لینک، تبلیغات و فوروارد ممنوع است.\n۳. ارسال محتوای نامناسب باعث اخراج می‌شود.",
  maxWarns: 3,
  warnAction: "mute",
  bannedWords: [],
  warns: {}
};

const SAFE_SHORT_WORDS = new Set([
  "سلام", "علیکم", "درود", "خوبی", "چطوری", "مرسی", "ممنون", "سپاس",
  "صبح بخیر", "شب بخیر", "خسته نباشید", "بله", "آره", "نه", "خیر",
  "اوکی", "باشه", "حتما", "موافقم", "ok", "hi", "hello", "thanks"
]);

const adminCache = new Map();
const floodCache = new Map();
let cachedBotInfo = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonRes({
        ok: true,
        bot: "Persian Group Manager Bot v2",
        kvConnected: Boolean(env.BOT_KV),
        tokenSet: Boolean(env.BOT_TOKEN),
        aiReady: Boolean(env.GROQ_API_KEY || env.GEMINI_API_KEY)
      });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      return handleSetup(env, url);
    }

    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
      if (env.WEBHOOK_SECRET) {
        const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (hdr !== env.WEBHOOK_SECRET) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      try {
        const update = await request.json();
        if (update.callback_query) {
          await handleCallback(env, ctx, update.callback_query);
        } else if (update.message) {
          await handleMessage(env, ctx, update.message);
        }
      } catch (err) {
        console.error("Update error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    if (!env.BOT_TOKEN || !env.BOT_KV) return;
    await runNightLockSweep(env);
  }
};

async function handleSetup(env, url) {
  if (!env.BOT_TOKEN) {
    return new Response("خطا: متغیر BOT_TOKEN ثبت نشده است.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
  const expectedKey = env.SETUP_KEY || "1234";
  if (url.searchParams.get("key") !== expectedKey) {
    return new Response("کلید راه‌اندازی اشتباه است.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  const webhookUrl = `${url.origin}/webhook`;
  const payload = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  };
  if (env.WEBHOOK_SECRET) payload.secret_token = env.WEBHOOK_SECRET;

  const res = await tg(env.BOT_TOKEN, "setWebhook", payload);
  return new Response(
    res.ok ? `✅ ربات متصل شد!\nآدرس: ${webhookUrl}` : `❌ خطا: ${JSON.stringify(res)}`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

async function handleMessage(env, ctx, msg) {
  const chat = msg.chat;
  if (!chat) return;

  if (chat.type === "private") {
    const text = (msg.text || "").trim();
    if (text.startsWith("/start") || text === "راهنما" || text === "/help") {
      await sendText(
        env.BOT_TOKEN,
        chat.id,
        "سلام! من ربات هوشمند ۲۴ ساعته مدیریت گروه هستم.\n\n" +
          "۱. من را به گروه اضافه و **ادمین (Admin)** کن.\n" +
          "۲. توی گروه بنویس **پنل** تا قفل شبانه، هوش مصنوعی و پاکسازی را تنظیم کنی.\n" +
          "۳. اعضا می‌توانند با نوشتن **بات ...** یا ریپلای روی پیام‌های من سوال بپرسند!"
      );
    }
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const settings = await getSettings(env, chat.id);

  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    if (settings.cleanService) {
      await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
    }
    const adderIsAdmin = await checkAdmin(env, chat.id, msg);
    for (const member of msg.new_chat_members) {
      if (member.is_bot) {
        if (settings.lockBots && !adderIsAdmin) {
          await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chat.id, user_id: member.id });
          await sendTempText(env, ctx, chat.id, `🤖 ربات غیرمجاز (${escapeHtml(member.first_name)}) اخراج شد.`, settings);
        }
        continue;
      }
      if (settings.welcomeEnabled) {
        const welcome = settings.welcomeText.replaceAll("{name}", mentionUser(member));
        await sendTempText(env, ctx, chat.id, welcome, settings);
      }
    }
    return;
  }

  if (msg.left_chat_member && settings.cleanService) {
    await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
    return;
  }

  const isAdmin = await checkAdmin(env, chat.id, msg);
  const rawText = (msg.text || msg.caption || "").trim();

  if (rawText === "قوانین" || rawText === "/rules") {
    await sendText(env.BOT_TOKEN, chat.id, `📜 <b>قوانین گروه:</b>\n\n${escapeHtml(settings.rulesText)}`, msg.message_id);
    return;
  }

  if (isAdmin && rawText) {
    const handled = await handleAdminCommand(env, ctx, msg, rawText, settings);
    if (handled) return;
  }

  // بررسی قفل‌ها و ضد اسپم و فحش هوشمند فقط برای اعضای عادی
  if (!isAdmin) {
    if (settings.antiFlood && msg.from && trackFlood(chat.id, msg.from.id)) {
      await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
      await muteUser(env.BOT_TOKEN, chat.id, msg.from.id, 5);
      await sendTempText(
        env,
        ctx,
        chat.id,
        `⏱ کاربر ${mentionUser(msg.from)} به دلیل ارسال رگباری پیام به مدت ۵ دقیقه سکوت شد.`,
        settings
      );
      return;
    }

    let deleted = false;
    if (settings.lockForward && isForwarded(msg)) deleted = true;
    else if (settings.lockLink && hasLink(msg, rawText)) deleted = true;
    else if (settings.lockMention && hasMention(msg, rawText)) deleted = true;
    else if (settings.lockStickerGif && (msg.sticker || msg.animation)) deleted = true;
    else if (settings.lockMedia && (msg.photo || msg.video || msg.voice || msg.audio || msg.document)) deleted = true;
    else if (settings.bannedWords.length > 0 && rawText && hasBannedWord(rawText, settings.bannedWords)) deleted = true;

    if (deleted) {
      await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
      return;
    }

    // بررسی فحش و ناسزای مخفی با هوش مصنوعی
    if (settings.aiModeration && hasAiKey(env) && shouldCheckWithAi(rawText)) {
      const mod = await checkToxicityAi(env, rawText);
      if (mod?.toxic) {
        await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
        const who = msg.from ? mentionUser(msg.from) : "کاربر";
        await sendTempText(
          env,
          ctx,
          chat.id,
          `🛡 پیام ${who} به دلیل الفاظ نامناسب یا توهین توسط هوش مصنوعی حذف شد.`,
          settings
        );
        return;
      }
    }
  }

  // پاسخ‌گویی هوشمند به اعضای گروه و ادمین‌ها
  if (settings.aiChat && rawText) {
    const botInfo = await getBotInfo(env);
    const question = extractAiQuestion(msg, rawText, botInfo);
    if (question !== null) {
      if (!hasAiKey(env)) {
        await sendTempText(
          env,
          ctx,
          chat.id,
          "⚠️ کلید هوش مصنوعی (GROQ_API_KEY) در تنظیمات کلودفلر وارد نشده است.",
          settings,
          msg.message_id
        );
        return;
      }
      const replyContext = msg.reply_to_message?.text || msg.reply_to_message?.caption || "";
      const answer = await askAiAnswer(env, question, replyContext);
      if (answer) {
        await sendText(env.BOT_TOKEN, chat.id, escapeHtml(answer), msg.message_id);
      }
    }
  }
}

async function handleAdminCommand(env, ctx, msg, text, settings) {
  const chatId = msg.chat.id;
  const reply = msg.reply_to_message;
  const cmd = text.toLowerCase();

  if (text === "پنل" || cmd === "/panel" || cmd === "/settings") {
    await sendPanel(env, chatId, settings);
    return true;
  }

  if (text === "راهنما" || cmd === "/help") {
    await sendText(env.BOT_TOKEN, chatId, buildHelpText(), msg.message_id);
    return true;
  }

  if (text === "حذف" || cmd === "/del") {
    if (reply) await deleteMsg(env.BOT_TOKEN, chatId, reply.message_id);
    await deleteMsg(env.BOT_TOKEN, chatId, msg.message_id);
    return true;
  }

  const cleanMatch = text.match(/^(?:پاکسازی|\/clean|\/purge)\s+(\d+)$/i);
  if (cleanMatch) {
    const count = Math.min(Math.max(parseInt(cleanMatch[1], 10), 1), 50);
    const ids = [];
    for (let i = 0; i <= count; i++) {
      const id = msg.message_id - i;
      if (id > 0) ids.push(id);
    }
    await tg(env.BOT_TOKEN, "deleteMessages", { chat_id: chatId, message_ids: ids });
    await sendTempText(env, ctx, chatId, `🧹 تا ${count} پیام اخیر پاکسازی شد.`, settings);
    return true;
  }

  const nightMatch = text.match(/^تنظیم شب\s+(\d{1,2}(?::\d{2})?)\s+(?:تا|الی|-)\s+(\d{1,2}(?::\d{2})?)$/);
  if (nightMatch) {
    const startStr = normalizeTimeStr(nightMatch[1]);
    const endStr = normalizeTimeStr(nightMatch[2]);
    if (!startStr || !endStr) {
      await sendTempText(env, ctx, chatId, "❌ فرمت ساعت اشتباه است. مثال درست:\nتنظیم شب 23:30 تا 08:00", settings, msg.message_id);
      return true;
    }
    settings.nightStart = startStr;
    settings.nightEnd = endStr;
    settings.nightLockEnabled = true;
    await saveSettings(env, chatId, settings);
    await sendText(
      env.BOT_TOKEN,
      chatId,
      `🌙 قفل شبانه فعال شد: از ساعت <b>${startStr}</b> تا <b>${endStr}</b> به وقت ایران گروه خودکار بسته و سپس باز می‌شود.`,
      msg.message_id
    );
    return true;
  }

  if (text === "پین" || cmd === "/pin") {
    if (reply) {
      await tg(env.BOT_TOKEN, "pinChatMessage", { chat_id: chatId, message_id: reply.message_id });
      await sendTempText(env, ctx, chatId, "📌 پیام پین شد.", settings, msg.message_id);
    }
    return true;
  }

  if (text === "انپین" || cmd === "/unpin") {
    await tg(env.BOT_TOKEN, "unpinChatMessage", { chat_id: chatId });
    await sendTempText(env, ctx, chatId, "پین پیام برداشته شد.", settings, msg.message_id);
    return true;
  }

  if ((text === "اخطار" || cmd === "/warn") && reply?.from) {
    await issueWarn(env, ctx, chatId, reply.from, settings, msg.message_id);
    return true;
  }

  if ((text === "حذف اخطار" || cmd === "/unwarn") && reply?.from) {
    delete settings.warns[String(reply.from.id)];
    await saveSettings(env, chatId, settings);
    await sendTempText(env, ctx, chatId, `✅ اخطارهای ${mentionUser(reply.from)} پاک شد.`, settings, msg.message_id);
    return true;
  }

  if ((text.startsWith("سکوت") || cmd.startsWith("/mute")) && reply?.from) {
    const numMatch = text.match(/(\d+)/);
    const minutes = numMatch ? parseInt(numMatch[1], 10) : 0;
    await muteUser(env.BOT_TOKEN, chatId, reply.from.id, minutes);
    const durText = minutes > 0 ? `به مدت ${minutes} دقیقه` : "به صورت دائم";
    await sendTempText(env, ctx, chatId, `🔇 کاربر ${mentionUser(reply.from)} ${durText} سکوت شد.`, settings, msg.message_id);
    return true;
  }

  if ((text === "آزاد" || cmd === "/unmute") && reply?.from) {
    await unmuteUser(env.BOT_TOKEN, chatId, reply.from.id);
    await sendTempText(env, ctx, chatId, `🔊 سکوت کاربر ${mentionUser(reply.from)} برداشته شد.`, settings, msg.message_id);
    return true;
  }

  if ((text === "بن" || text === "اخراج" || cmd === "/ban" || cmd === "/kick") && reply?.from) {
    await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chatId, user_id: reply.from.id });
    if (text === "اخراج" || cmd === "/kick") {
      await tg(env.BOT_TOKEN, "unbanChatMember", { chat_id: chatId, user_id: reply.from.id, only_if_banned: true });
      await sendTempText(env, ctx, chatId, `👢 کاربر ${mentionUser(reply.from)} از گروه اخراج شد.`, settings, msg.message_id);
    } else {
      await sendTempText(env, ctx, chatId, `🚫 کاربر ${mentionUser(reply.from)} از گروه بن شد.`, settings, msg.message_id);
    }
    return true;
  }

  if ((text === "آنبن" || cmd === "/unban") && reply?.from) {
    await tg(env.BOT_TOKEN, "unbanChatMember", { chat_id: chatId, user_id: reply.from.id, only_if_banned: true });
    await sendTempText(env, ctx, chatId, `✅ محرومیت ${mentionUser(reply.from)} برداشته شد.`, settings, msg.message_id);
    return true;
  }

  if (text.startsWith("تنظیم قوانین ")) {
    settings.rulesText = text.replace("تنظیم قوانین ", "").trim();
    await saveSettings(env, chatId, settings);
    await sendTempText(env, ctx, chatId, "✅ قوانین جدید گروه ذخیره شد.", settings, msg.message_id);
    return true;
  }

  if (text.startsWith("تنظیم خوشامد ")) {
    settings.welcomeText = text.replace("تنظیم خوشامد ", "").trim();
    await saveSettings(env, chatId, settings);
    await sendTempText(env, ctx, chatId, "✅ متن خوشامدگویی ذخیره شد.", settings, msg.message_id);
    return true;
  }

  if (text.startsWith("افزودن کلمه ") || cmd.startsWith("/addword ")) {
    const word = text.replace(/^افزودن کلمه\s+|^\/addword\s+/i, "").trim().toLowerCase();
    if (word && !settings.bannedWords.includes(word)) {
      settings.bannedWords.push(word);
      await saveSettings(env, chatId, settings);
    }
    await sendTempText(env, ctx, chatId, `✅ کلمه «${escapeHtml(word)}» به لیست فیلتر اضافه شد.`, settings, msg.message_id);
    return true;
  }

  if (text.startsWith("حذف کلمه ") || cmd.startsWith("/delword ")) {
    const word = text.replace(/^حذف کلمه\s+|^\/delword\s+/i, "").trim().toLowerCase();
    settings.bannedWords = settings.bannedWords.filter((w) => w !== word);
    await saveSettings(env, chatId, settings);
    await sendTempText(env, ctx, chatId, `🗑 کلمه «${escapeHtml(word)}» از لیست فیلتر حذف شد.`, settings, msg.message_id);
    return true;
  }

  if (text === "لیست کلمات" || cmd === "/words") {
    const list = settings.bannedWords.length > 0 ? settings.bannedWords.join("، ") : "خالی است";
    await sendText(env.BOT_TOKEN, chatId, `🚫 کلمات فیلترشده:\n${escapeHtml(list)}`, msg.message_id);
    return true;
  }

  return false;
}

async function handleCallback(env, ctx, cb) {
  const data = cb.data || "";
  const msg = cb.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const isAdmin = await isUserAdmin(env, chatId, cb.from.id);
  if (!isAdmin) {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "فقط ادمین‌های گروه اجازه تغییر تنظیمات را دارند!",
      show_alert: true
    });
    return;
  }

  const settings = await getSettings(env, chatId);

  if (data.startsWith("toggle:")) {
    const key = data.split(":")[1];
    if (key in settings && typeof settings[key] === "boolean") {
      settings[key] = !settings[key];
      await saveSettings(env, chatId, settings);
      await tg(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: msg.message_id,
        reply_markup: buildPanelMarkup(settings)
      });
    }
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "به‌روزرسانی شد ✅" });
    return;
  }

  if (data === "cycle_warn") {
    settings.warnAction = settings.warnAction === "mute" ? "ban" : "mute";
    await saveSettings(env, chatId, settings);
    await tg(env.BOT_TOKEN, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: buildPanelMarkup(settings)
    });
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "مجازات اخطار تغییر کرد" });
    return;
  }

  if (data.startsWith("unwarn:")) {
    const uid = data.split(":")[1];
    delete settings.warns[uid];
    await saveSettings(env, chatId, settings);
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "اخطارها پاک شد ✅" });
    await tg(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: msg.message_id,
      text: "✅ اخطارهای کاربر توسط ادمین بخشیده شد.",
      parse_mode: "HTML"
    });
    return;
  }

  if (data === "close_panel") {
    await deleteMsg(env.BOT_TOKEN, chatId, msg.message_id);
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
  }
}

async function runNightLockSweep(env) {
  const tehran = new Date(Date.now() + 3.5 * 60 * 60 * 1000);
  const currentMins = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();

  let cursor;
  do {
    const listRes = await env.BOT_KV.list({ prefix: "group:", cursor });
    for (const item of listRes.keys) {
      const chatId = item.name.replace("group:", "");
      const settings = await getSettings(env, chatId);
      if (!settings.nightLockEnabled) continue;

      const startMins = parseTimeMins(settings.nightStart);
      const endMins = parseTimeMins(settings.nightEnd);
      if (startMins === null || endMins === null) continue;

      const shouldBeLocked = isTimeInRange(currentMins, startMins, endMins);

      if (shouldBeLocked && !settings.nightIsLocked) {
        await setGroupChatPermissions(env.BOT_TOKEN, chatId, false);
        settings.nightIsLocked = true;
        await saveSettings(env, chatId, settings);
        await sendText(
          env.BOT_TOKEN,
          chatId,
          `🌙 <b>قفل شبانه فعال شد</b>\nچت برای اعضای عادی تا ساعت <b>${settings.nightEnd}</b> به وقت ایران بسته است.`
        );
      } else if (!shouldBeLocked && settings.nightIsLocked) {
        await setGroupChatPermissions(env.BOT_TOKEN, chatId, true);
        settings.nightIsLocked = false;
        await saveSettings(env, chatId, settings);
        await sendText(
          env.BOT_TOKEN,
          chatId,
          `☀️ <b>قفل شبانه برداشته شد</b>\nگروه باز شد و هم‌اکنون می‌توانید پیام ارسال کنید.`
        );
      }
    }
    cursor = listRes.list_complete ? undefined : listRes.cursor;
  } while (cursor);
}

async function setGroupChatPermissions(token, chatId, open) {
  await tg(token, "setChatPermissions", {
    chat_id: chatId,
    permissions: {
      can_send_messages: open,
      can_send_audios: open,
      can_send_documents: open,
      can_send_photos: open,
      can_send_videos: open,
      can_send_video_notes: open,
      can_send_voice_notes: open,
      can_send_polls: open,
      can_send_other_messages: open,
      can_add_web_page_previews: open
    }
  });
}

function normalizeTimeStr(raw) {
  const parts = raw.split(":");
  const h = parseInt(parts[0], 10);
  const m = parts[1] !== undefined ? parseInt(parts[1], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  const roundedM = m >= 30 ? 30 : 0;
  return `${String(h).padStart(2, "0")}:${String(roundedM).padStart(2, "0")}`;
}

function parseTimeMins(str) {
  const m = /^(\d{2}):(\d{2})$/.exec(str || "");
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function isTimeInRange(now, start, end) {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function hasAiKey(env) {
  return Boolean(env.GROQ_API_KEY || env.GEMINI_API_KEY);
}

function shouldCheckWithAi(text) {
  if (!text || text.length < 2) return false;
  const normalized = text.trim().toLowerCase().replace(/[.!؟،]+$/g, "");
  if (SAFE_SHORT_WORDS.has(normalized)) return false;
  return /[\p{L}\p{N}]/u.test(normalized);
}

async function checkToxicityAi(env, text) {
  const sys =
    "You are a Persian/Finglish group chat moderator. Detect severe profanity, sexual insults, slurs, or disguised swear words (with spaces, dots, symbols, or Finglish like k*r, kos, bi shooor). Ignore normal friendly banter or polite disagreement. Reply ONLY with valid JSON: {\"toxic\": true or false}";
  const raw = await callBestAi(env, sys, text.slice(0, 600), 60, true);
  if (!raw) return null;
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
  } catch {}
  return null;
}

function extractAiQuestion(msg, rawText, botInfo) {
  const triggerRegex = /^(?:هوش|بات|ربات|سوال|\/ai)\s+([\s\S]+)/i;
  const match = rawText.match(triggerRegex);
  if (match) return match[1].trim();

  if (botInfo?.username) {
    const mentionRegex = new RegExp(`@${botInfo.username}\\b`, "ig");
    if (mentionRegex.test(rawText)) {
      const cleaned = rawText.replace(mentionRegex, "").trim();
      return cleaned || "سلام! چطور می‌تونم کمکت کنم؟";
    }
  }

  if (botInfo?.id && msg.reply_to_message?.from?.id === botInfo.id) {
    return rawText;
  }

  return null;
}

async function askAiAnswer(env, question, contextText) {
  const sys =
    "تو یک دستیار باهوش، مودب و صمیمی در یک گروه تلگرامی فارسی هستی. کوتاه، دقیق و روان به زبان فارسی پاسخ بده (حداکثر ۸ خط).";
  const userContent = contextText
    ? `پیام قبلی برای زمینه:\n${contextText.slice(0, 800)}\n\nسوال کاربر:\n${question.slice(0, 1000)}`
    : question.slice(0, 1200);

  return callBestAi(env, sys, userContent, 500, false);
}

async function callBestAi(env, systemPrompt, userPrompt, maxTokens, jsonMode) {
  if (env.GROQ_API_KEY) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen/qwen3.8-27b",
        temperature: jsonMode ? 0 : 0.4,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
  }

  if (env.GEMINI_API_KEY) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": env.GEMINI_API_KEY.trim(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: "application/json" } : {})
        }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("\n").trim();
      if (text) return text;
    }
  }

  return null;
}

async function getBotInfo(env) {
  if (cachedBotInfo) return cachedBotInfo;
  const res = await tg(env.BOT_TOKEN, "getMe", {});
  if (res?.ok && res.result) {
    cachedBotInfo = res.result;
  }
  return cachedBotInfo;
}

async function issueWarn(env, ctx, chatId, targetUser, settings, replyToId) {
  const uid = String(targetUser.id);
  const current = (settings.warns[uid] || 0) + 1;
  settings.warns[uid] = current;

  if (current >= settings.maxWarns) {
    settings.warns[uid] = 0;
    await saveSettings(env, chatId, settings);
    if (settings.warnAction === "ban") {
      await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chatId, user_id: targetUser.id });
      await sendTempText(env, ctx, chatId, `🚫 کاربر ${mentionUser(targetUser)} به دلیل ${settings.maxWarns} اخطار بن شد.`, settings, replyToId);
    } else {
      await muteUser(env.BOT_TOKEN, chatId, targetUser.id, 60);
      await sendTempText(env, ctx, chatId, `🔇 کاربر ${mentionUser(targetUser)} به دلیل ${settings.maxWarns} اخطار، ۶۰ دقیقه سکوت شد.`, settings, replyToId);
    }
    return;
  }

  await saveSettings(env, chatId, settings);
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: `⚠️ اخطار <b>${current} از ${settings.maxWarns}</b> به ${mentionUser(targetUser)} داده شد.`,
    parse_mode: "HTML",
    reply_to_message_id: replyToId,
    reply_markup: {
      inline_keyboard: [[{ text: "بخشیدن اخطارها 🕊", callback_data: `unwarn:${uid}` }]]
    }
  });
}

async function sendPanel(env, chatId, settings) {
  const aiNote = hasAiKey(env) ? "" : "\n⚠️ کلید هوش مصنوعی (GROQ_API_KEY) هنوز در کلودفلر ثبت نشده است.";
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: `⚙️ <b>پنل مدیریت هوشمند گروه</b>\nبرای تغییر هر مورد روی دکمه‌اش بزنید:${aiNote}`,
    parse_mode: "HTML",
    reply_markup: buildPanelMarkup(settings)
  });
}

function buildPanelMarkup(s) {
  const icon = (v) => (v ? "🔒" : "🔓");
  const sw = (v) => (v ? "✅" : "❌");
  const actText = s.warnAction === "mute" ? "سکوت ۱ ساعته" : "بن دائم";
  return {
    inline_keyboard: [
      [
        { text: `${icon(s.lockLink)} قفل لینک`, callback_data: "toggle:lockLink" },
        { text: `${icon(s.lockForward)} قفل فوروارد`, callback_data: "toggle:lockForward" }
      ],
      [
        { text: `${icon(s.lockMention)} قفل آیدی (@)`, callback_data: "toggle:lockMention" },
        { text: `${icon(s.lockStickerGif)} استیکر و گیف`, callback_data: "toggle:lockStickerGif" }
      ],
      [
        { text: `${icon(s.lockMedia)} عکس و رسانه`, callback_data: "toggle:lockMedia" },
        { text: `${icon(s.lockBots)} قفل ربات`, callback_data: "toggle:lockBots" }
      ],
      [
        { text: `${sw(s.antiFlood)} ضد اسپم رگباری`, callback_data: "toggle:antiFlood" },
        { text: `${sw(s.welcomeEnabled)} خوشامدگویی`, callback_data: "toggle:welcomeEnabled" }
      ],
      [
        { text: `${sw(s.cleanService)} حذف ورود/خروج`, callback_data: "toggle:cleanService" },
        { text: `${sw(s.autoDeleteBotMsgs)} پاکسازی خودکار ربات`, callback_data: "toggle:autoDeleteBotMsgs" }
      ],
      [
        { text: `${sw(s.aiModeration)} ضد فحش هوشمند AI`, callback_data: "toggle:aiModeration" },
        { text: `${sw(s.aiChat)} پاسخ‌گویی AI`, callback_data: "toggle:aiChat" }
      ],
      [
        { text: `${sw(s.nightLockEnabled)} قفل شب (${s.nightStart}-${s.nightEnd})`, callback_data: "toggle:nightLockEnabled" }
      ],
      [
        { text: `⚖️ مجازات ۳ اخطار: ${actText}`, callback_data: "cycle_warn" }
      ],
      [{ text: "بستن پنل ❌", callback_data: "close_panel" }]
    ]
  };
}

function buildHelpText() {
  return (
    "📖 <b>راهنمای دستورات ادمین:</b>\n\n" +
    "• <b>پنل</b> — منوی شیشه‌ای قفل‌ها، AI و قفل شبانه\n" +
    "• <b>تنظیم شب 23:30 تا 08:00</b> — ساعت قفل شبانه (به وقت ایران)\n" +
    "• <b>پاکسازی 20</b> — حذف تا ۵۰ پیام اخیر گروه\n" +
    "• <b>اخطار</b> / <b>حذف اخطار</b> (ریپلای)\n" +
    "• <b>سکوت 60</b> یا <b>سکوت</b> / <b>آزاد</b> (ریپلای)\n" +
    "• <b>بن</b> / <b>اخراج</b> / <b>آنبن</b> (ریپلای)\n" +
    "• <b>حذف</b> / <b>پین</b> / <b>انپین</b> (ریپلای)\n" +
    "• <b>افزودن کلمه ...</b> / <b>حذف کلمه ...</b> / <b>لیست کلمات</b>\n" +
    "• <b>تنظیم قوانین ...</b> / <b>تنظیم خوشامد ...</b>\n\n" +
    "🤖 <b>صحبت با هوش مصنوعی (برای همه اعضا):</b>\n" +
    "بنویسید: <b>بات [سوال شما]</b> یا روی پیام ربات ریپلای کنید!"
  );
}

function trackFlood(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const timestamps = (floodCache.get(key) || []).filter((t) => now - t < 8000);
  timestamps.push(now);
  floodCache.set(key, timestamps);
  if (floodCache.size > 2000) floodCache.clear();
  return timestamps.length >= 6;
}

function isForwarded(msg) {
  return Boolean(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat);
}

function hasLink(msg, text) {
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  if (entities.some((e) => e.type === "url" || e.type === "text_link")) return true;
  return /(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test(text);
}

function hasMention(msg, text) {
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  if (entities.some((e) => e.type === "mention")) return true;
  return /@[a-zA-Z0-9_]{3,}/.test(text);
}

function hasBannedWord(text, words) {
  const lower = text.toLowerCase();
  return words.some((w) => w && lower.includes(w));
}

async function checkAdmin(env, chatId, msg) {
  if (msg.sender_chat && msg.sender_chat.id === chatId) return true;
  if (!msg.from) return false;
  if (msg.from.id === 1087968824) return true;
  return isUserAdmin(env, chatId, msg.from.id);
}

async function isUserAdmin(env, chatId, userId) {
  if (env.OWNER_ID && String(userId) === String(env.OWNER_ID)) return true;
  const cacheKey = `${chatId}:${userId}`;
  const cached = adminCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60000) return cached.isAdmin;

  const res = await tg(env.BOT_TOKEN, "getChatMember", { chat_id: chatId, user_id: userId });
  const status = res?.result?.status;
  const ok = status === "creator" || status === "administrator";
  adminCache.set(cacheKey, { isAdmin: ok, ts: Date.now() });
  if (adminCache.size > 2000) adminCache.clear();
  return ok;
}

async function muteUser(token, chatId, userId, minutes) {
  const payload = {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false
    }
  };
  if (minutes > 0) payload.until_date = Math.floor(Date.now() / 1000) + minutes * 60;
  await tg(token, "restrictChatMember", payload);
}

async function unmuteUser(token, chatId, userId) {
  await tg(token, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true
    }
  });
}

async function getSettings(env, chatId) {
  const base = { ...DEFAULT_SETTINGS, bannedWords: [], warns: {} };
  if (!env.BOT_KV) return base;
  const raw = await env.BOT_KV.get(`group:${chatId}`);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw);
    return {
      ...base,
      ...parsed,
      bannedWords: Array.isArray(parsed.bannedWords) ? parsed.bannedWords : [],
      warns: parsed.warns && typeof parsed.warns === "object" ? parsed.warns : {}
    };
  } catch {
    return base;
  }
}

async function saveSettings(env, chatId, settings) {
  if (!env.BOT_KV) return;
  await env.BOT_KV.put(`group:${chatId}`, JSON.stringify(settings));
}

async function sendText(token, chatId, text, replyToId) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyToId) payload.reply_to_message_id = replyToId;
  return tg(token, "sendMessage", payload);
}

async function sendTempText(env, ctx, chatId, text, settings, replyToId) {
  const res = await sendText(env.BOT_TOKEN, chatId, text, replyToId);
  const sentId = res?.result?.message_id;
  if (settings.autoDeleteBotMsgs && sentId && ctx) {
    ctx.waitUntil(
      new Promise((resolve) => setTimeout(resolve, 15000)).then(() =>
        deleteMsg(env.BOT_TOKEN, chatId, sentId)
      )
    );
  }
}

async function deleteMsg(token, chatId, messageId) {
  await tg(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

function mentionUser(user) {
  const name = escapeHtml(user.first_name || "کاربر");
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
