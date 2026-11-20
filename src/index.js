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
  welcomeText: "سلام {name} عزیز! به گروه خوش اومدی.\nلطفاً برای دیدن مقررات گروه، کلمه «قوانین» را بفرست.",
  rulesText: "۱. احترام به تمام اعضا الزامی است.\n۲. ارسال لینک، تبلیغات و فوروارد ممنوع است.\n۳. ارسال محتوای نامناسب باعث اخراج می‌شود.",
  maxWarns: 3,
  warnAction: "mute", // "mute" or "ban"
  bannedWords: [],
  warns: {}
};

const adminCache = new Map();
const floodCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonRes({
        ok: true,
        bot: "Persian Group Manager Bot",
        kvConnected: Boolean(env.BOT_KV),
        tokenSet: Boolean(env.BOT_TOKEN)
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
          await handleCallback(env, update.callback_query);
        } else if (update.message) {
          await handleMessage(env, update.message);
        }
      } catch (err) {
        console.error("Update error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleSetup(env, url) {
  if (!env.BOT_TOKEN) {
    return new Response("خطا: متغیر BOT_TOKEN در تنظیمات Cloudflare ثبت نشده است.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
  const expectedKey = env.SETUP_KEY || "1234";
  if (url.searchParams.get("key") !== expectedKey) {
    return new Response("کلید راه‌اندازی (key) اشتباه است.", {
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
  if (env.WEBHOOK_SECRET) {
    payload.secret_token = env.WEBHOOK_SECRET;
  }

  const res = await tg(env.BOT_TOKEN, "setWebhook", payload);
  const kvNote = env.BOT_KV
    ? "دیتابیس BOT_KV متصل است."
    : "هشدار: دیتابیس BOT_KV هنوز متصل نشده؛ برای ذخیره دائمی تنظیمات از بخش Bindings متصلش کنید.";

  return new Response(
    res.ok
      ? `✅ ربات با موفقیت به تلگرام متصل شد!\nآدرس وب‌هوک: ${webhookUrl}\n${kvNote}`
      : `❌ خطا در اتصال: ${JSON.stringify(res)}`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

async function handleMessage(env, msg) {
  const chat = msg.chat;
  if (!chat) return;

  // چت خصوصی با ربات
  if (chat.type === "private") {
    const text = (msg.text || "").trim();
    if (text.startsWith("/start") || text === "راهنما" || text === "/help") {
      await sendText(
        env.BOT_TOKEN,
        chat.id,
        "سلام! من ربات ۲۴ ساعته مدیریت گروه هستم.\n\n" +
          "۱. من را به گروه خود اضافه کن.\n" +
          "۲. در تنظیمات گروه، من را **ادمین (Admin)** کن (با دسترسی حذف پیام و مسدودسازی اعضا).\n" +
          "۳. داخل گروه کلمه **پنل** یا **راهنما** را ارسال کن!"
      );
    }
    return;
  }

  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const settings = await getSettings(env, chat.id);

  // ورود عضو جدید + قفل ربات + حذف پیام سیستمی
  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    if (settings.cleanService) {
      await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
    }
    const adderIsAdmin = await checkAdmin(env, chat.id, msg);
    for (const member of msg.new_chat_members) {
      if (member.is_bot) {
        if (settings.lockBots && !adderIsAdmin) {
          await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chat.id, user_id: member.id });
          await sendText(env.BOT_TOKEN, chat.id, `🤖 ربات غیرمجاز (${escapeHtml(member.first_name)}) توسط قفل ربات اخراج شد.`);
        }
        continue;
      }
      if (settings.welcomeEnabled) {
        const welcome = settings.welcomeText.replaceAll("{name}", mentionUser(member));
        await sendText(env.BOT_TOKEN, chat.id, welcome);
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

  // دستورات عمومی اعضا
  if (rawText === "قوانین" || rawText === "/rules") {
    await sendText(env.BOT_TOKEN, chat.id, `📜 <b>قوانین گروه:</b>\n\n${escapeHtml(settings.rulesText)}`, msg.message_id);
    return;
  }

  // اجرای دستورات ادمین
  if (isAdmin && rawText) {
    const handled = await handleAdminCommand(env, msg, rawText, settings);
    if (handled) return;
  }

  // از اینجا به بعد فقط کاربران عادی بررسی می‌شوند
  if (isAdmin) return;

  // ضد رگبار پیام (Anti-Flood)
  if (settings.antiFlood && msg.from) {
    const isFlood = trackFlood(chat.id, msg.from.id);
    if (isFlood) {
      await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
      await muteUser(env.BOT_TOKEN, chat.id, msg.from.id, 5);
      await sendText(
        env.BOT_TOKEN,
        chat.id,
        `⏱ کاربر ${mentionUser(msg.from)} به دلیل ارسال رگباری پیام به مدت ۵ دقیقه سکوت شد.`
      );
      return;
    }
  }

  // بررسی قفل‌ها و کلمات ممنوعه
  let violation = null;
  if (settings.lockForward && isForwarded(msg)) {
    violation = "فوروارد پیام";
  } else if (settings.lockLink && hasLink(msg, rawText)) {
    violation = "ارسال لینک";
  } else if (settings.lockMention && hasMention(msg, rawText)) {
    violation = "ارسال آیدی/منشن";
  } else if (settings.lockStickerGif && (msg.sticker || msg.animation)) {
    violation = "ارسال استیکر یا گیف";
  } else if (settings.lockMedia && (msg.photo || msg.video || msg.voice || msg.audio || msg.document)) {
    violation = "ارسال رسانه/فایل";
  } else if (settings.bannedWords.length > 0 && rawText && hasBannedWord(rawText, settings.bannedWords)) {
    violation = "استفاده از کلمه ممنوعه";
  }

  if (violation) {
    await deleteMsg(env.BOT_TOKEN, chat.id, msg.message_id);
  }
}

async function handleAdminCommand(env, msg, text, settings) {
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

  // دستورات ریپلای‌محور
  if (text === "حذف" || cmd === "/del") {
    if (reply) await deleteMsg(env.BOT_TOKEN, chatId, reply.message_id);
    await deleteMsg(env.BOT_TOKEN, chatId, msg.message_id);
    return true;
  }

  if (text === "پین" || cmd === "/pin") {
    if (reply) {
      await tg(env.BOT_TOKEN, "pinChatMessage", { chat_id: chatId, message_id: reply.message_id });
      await sendText(env.BOT_TOKEN, chatId, "📌 پیام پین شد.", msg.message_id);
    }
    return true;
  }

  if (text === "انپین" || cmd === "/unpin") {
    await tg(env.BOT_TOKEN, "unpinChatMessage", { chat_id: chatId });
    await sendText(env.BOT_TOKEN, chatId, "پین پیام برداشته شد.", msg.message_id);
    return true;
  }

  if ((text === "اخطار" || cmd === "/warn") && reply?.from) {
    await issueWarn(env, chatId, reply.from, settings, msg.message_id);
    return true;
  }

  if ((text === "حذف اخطار" || cmd === "/unwarn") && reply?.from) {
    const uid = String(reply.from.id);
    delete settings.warns[uid];
    await saveSettings(env, chatId, settings);
    await sendText(env.BOT_TOKEN, chatId, `✅ اخطارهای ${mentionUser(reply.from)} پاک شد.`, msg.message_id);
    return true;
  }

  if ((text.startsWith("سکوت") || cmd.startsWith("/mute")) && reply?.from) {
    const numMatch = text.match(/(\d+)/);
    const minutes = numMatch ? parseInt(numMatch[1], 10) : 0;
    await muteUser(env.BOT_TOKEN, chatId, reply.from.id, minutes);
    const durText = minutes > 0 ? `به مدت ${minutes} دقیقه` : "به صورت دائم";
    await sendText(env.BOT_TOKEN, chatId, `🔇 کاربر ${mentionUser(reply.from)} ${durText} سکوت شد.`, msg.message_id);
    return true;
  }

  if ((text === "آزاد" || cmd === "/unmute") && reply?.from) {
    await unmuteUser(env.BOT_TOKEN, chatId, reply.from.id);
    await sendText(env.BOT_TOKEN, chatId, `🔊 سکوت کاربر ${mentionUser(reply.from)} برداشته شد.`, msg.message_id);
    return true;
  }

  if ((text === "بن" || text === "اخراج" || cmd === "/ban" || cmd === "/kick") && reply?.from) {
    await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chatId, user_id: reply.from.id });
    if (text === "اخراج" || cmd === "/kick") {
      await tg(env.BOT_TOKEN, "unbanChatMember", { chat_id: chatId, user_id: reply.from.id, only_if_banned: true });
      await sendText(env.BOT_TOKEN, chatId, `👢 کاربر ${mentionUser(reply.from)} از گروه اخراج شد.`, msg.message_id);
    } else {
      await sendText(env.BOT_TOKEN, chatId, `🚫 کاربر ${mentionUser(reply.from)} از گروه بن شد.`, msg.message_id);
    }
    return true;
  }

  if ((text === "آنبن" || cmd === "/unban") && reply?.from) {
    await tg(env.BOT_TOKEN, "unbanChatMember", { chat_id: chatId, user_id: reply.from.id, only_if_banned: true });
    await sendText(env.BOT_TOKEN, chatId, `✅ محرومیت ${mentionUser(reply.from)} برداشته شد.`, msg.message_id);
    return true;
  }

  // تنظیمات متنی گروه
  if (text.startsWith("تنظیم قوانین ")) {
    settings.rulesText = text.replace("تنظیم قوانین ", "").trim();
    await saveSettings(env, chatId, settings);
    await sendText(env.BOT_TOKEN, chatId, "✅ قوانین جدید گروه ذخیره شد.", msg.message_id);
    return true;
  }

  if (text.startsWith("تنظیم خوشامد ")) {
    settings.welcomeText = text.replace("تنظیم خوشامد ", "").trim();
    await saveSettings(env, chatId, settings);
    await sendText(env.BOT_TOKEN, chatId, "✅ متن خوشامدگویی ذخیره شد (می‌توانید از {name} استفاده کنید).", msg.message_id);
    return true;
  }

  if (text.startsWith("افزودن کلمه ") || cmd.startsWith("/addword ")) {
    const word = text.replace(/^افزودن کلمه\s+|^\/addword\s+/i, "").trim().toLowerCase();
    if (word && !settings.bannedWords.includes(word)) {
      settings.bannedWords.push(word);
      await saveSettings(env, chatId, settings);
    }
    await sendText(env.BOT_TOKEN, chatId, `✅ کلمه «${escapeHtml(word)}» به لیست فیلتر اضافه شد.`, msg.message_id);
    return true;
  }

  if (text.startsWith("حذف کلمه ") || cmd.startsWith("/delword ")) {
    const word = text.replace(/^حذف کلمه\s+|^\/delword\s+/i, "").trim().toLowerCase();
    settings.bannedWords = settings.bannedWords.filter((w) => w !== word);
    await saveSettings(env, chatId, settings);
    await sendText(env.BOT_TOKEN, chatId, `🗑 کلمه «${escapeHtml(word)}» از لیست فیلتر حذف شد.`, msg.message_id);
    return true;
  }

  if (text === "لیست کلمات" || cmd === "/words") {
    const list = settings.bannedWords.length > 0 ? settings.bannedWords.join("، ") : "خالی است";
    await sendText(env.BOT_TOKEN, chatId, `🚫 کلمات فیلترشده:\n${escapeHtml(list)}`, msg.message_id);
    return true;
  }

  return false;
}

async function handleCallback(env, cb) {
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

async function issueWarn(env, chatId, targetUser, settings, replyToId) {
  const uid = String(targetUser.id);
  const current = (settings.warns[uid] || 0) + 1;
  settings.warns[uid] = current;

  if (current >= settings.maxWarns) {
    settings.warns[uid] = 0;
    await saveSettings(env, chatId, settings);
    if (settings.warnAction === "ban") {
      await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chatId, user_id: targetUser.id });
      await sendText(env.BOT_TOKEN, chatId, `🚫 کاربر ${mentionUser(targetUser)} به دلیل رسیدن به ${settings.maxWarns} اخطار از گروه بن شد.`, replyToId);
    } else {
      await muteUser(env.BOT_TOKEN, chatId, targetUser.id, 60);
      await sendText(env.BOT_TOKEN, chatId, `🔇 کاربر ${mentionUser(targetUser)} به دلیل رسیدن به ${settings.maxWarns} اخطار، ۶۰ دقیقه سکوت شد.`, replyToId);
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
  const kvWarn = env.BOT_KV ? "" : "\n⚠️ توجه: دیتابیس BOT_KV متصل نیست (تغییرات موقتی است).";
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: `⚙️ <b>پنل مدیریت گروه</b>\nبرای تغییر هر مورد روی دکمه‌اش بزنید:${kvWarn}`,
    parse_mode: "HTML",
    reply_markup: buildPanelMarkup(settings)
  });
}

function buildPanelMarkup(s) {
  const icon = (v) => (v ? "🔒" : "🔓");
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
        { text: `${s.antiFlood ? "✅" : "❌"} ضد اسپم رگباری`, callback_data: "toggle:antiFlood" },
        { text: `${s.welcomeEnabled ? "✅" : "❌"} خوشامدگویی`, callback_data: "toggle:welcomeEnabled" }
      ],
      [
        { text: `${s.cleanService ? "✅" : "❌"} حذف ورود/خروج`, callback_data: "toggle:cleanService" },
        { text: `⚖️ مجازات ۳ اخطار: ${actText}`, callback_data: "cycle_warn" }
      ],
      [{ text: "بستن پنل ❌", callback_data: "close_panel" }]
    ]
  };
}

function buildHelpText() {
  return (
    "📖 <b>راهنمای دستورات ادمین:</b>\n\n" +
    "• <b>پنل</b> — باز کردن منوی شیشه‌ای قفل‌ها و تنظیمات\n" +
    "• <b>اخطار</b> (ریپلای) — ثبت اخطار (۳ اخطار = مجازات)\n" +
    "• <b>حذف اخطار</b> (ریپلای) — پاک کردن اخطارهای کاربر\n" +
    "• <b>سکوت 60</b> یا <b>سکوت</b> (ریپلای) — سکوت ۶۰ دقیقه‌ای یا دائم\n" +
    "• <b>آزاد</b> (ریپلای) — رفع سکوت کاربر\n" +
    "• <b>بن</b> / <b>اخراج</b> / <b>آنبن</b> (ریپلای)\n" +
    "• <b>حذف</b> / <b>پین</b> / <b>انپین</b> (ریپلای)\n" +
    "• <b>افزودن کلمه ...</b> / <b>حذف کلمه ...</b> / <b>لیست کلمات</b>\n" +
    "• <b>تنظیم قوانین ...</b> / <b>تنظیم خوشامد ...</b>\n" +
    "• <b>قوانین</b> — نمایش قوانین گروه برای همه"
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
  if (minutes > 0) {
    payload.until_date = Math.floor(Date.now() / 1000) + minutes * 60;
  }
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
  await tg(token, "sendMessage", payload);
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
