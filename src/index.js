const DEFAULT_CONFIG = {
  ownerId: null,
  targetChatId: null,
  targetChatTitle: "",
  autoSendEnabled: true,
  imageMode: true,
  scheduleTime: "09:00",
  lastSentDate: "",
  asbdavaniUrl: "https://asbdavani.app/racecards",
  tjkUrl: "https://www.tjk.org/TR/YarisSever/Info/Page/GunlukYarisProgrami",
  intlUrl: "https://www.sportinglife.com/racing/racecards"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      const cfg = await getConfig(env);
      const asb = await getJsonKv(env, "cache:asbdavani");
      const tjk = await getJsonKv(env, "cache:tjk_cities");
      const intl = await getJsonKv(env, "cache:intl_meetings");
      return jsonRes({
        ok: true,
        bot: "Racing Bot v5.0 (Image + AGF + Iran/TR/EU)",
        kvConnected: Boolean(env.BOT_KV),
        tokenSet: Boolean(env.BOT_TOKEN),
        aiReady: hasAiKey(env),
        imageRendererReady: Boolean(env.IMAGE_RENDER_URL),
        imageMode: cfg.imageMode !== false,
        iranRounds: asb?.races?.length || 0,
        turkeyCities: tjk?.cities?.length || 0,
        intlMeetings: intl?.meetings?.length || 0,
        targetGroupSet: Boolean(cfg.targetChatId),
        scheduleTime: cfg.scheduleTime
      });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      return handleSetup(env, url);
    }

    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
      if (env.WEBHOOK_SECRET) {
        const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (hdr !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
      }
      try {
        const update = await request.json();
        if (update.callback_query) {
          await handleCallback(env, ctx, update.callback_query);
        } else if (update.message) {
          await handleMessage(env, update.message);
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
    const cfg = await getConfig(env);
    if (!cfg.autoSendEnabled) return;

    const { hhmm, dateStr } = getTehranNow();
    if (cfg.scheduleTime === hhmm && cfg.lastSentDate !== dateStr) {
      cfg.lastSentDate = dateStr;
      await saveConfig(env, cfg);
      ctx.waitUntil(
        (async () => {
          await refreshAsbdavaniCache(env, cfg);
          await refreshTjkCitiesCache(env, cfg);
          await refreshIntlMeetingsCache(env, cfg);
          if (cfg.targetChatId) {
            await sendPublicSitesMenu(env, cfg.targetChatId);
          }
        })()
      );
    }
  }
};

async function handleSetup(env, url) {
  if (!env.BOT_TOKEN) return textRes("خطا: متغیر BOT_TOKEN ثبت نشده است.", 400);
  const expected = env.SETUP_KEY || "1234";
  if (url.searchParams.get("key") !== expected) return textRes("کلید راه‌اندازی اشتباه است.", 403);

  const webhookUrl = `${url.origin}/webhook`;
  const payload = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  };
  if (env.WEBHOOK_SECRET) payload.secret_token = env.WEBHOOK_SECRET;

  const res = await tg(env.BOT_TOKEN, "setWebhook", payload);
  return textRes(res.ok ? `✅ ربات متصل شد!\nآدرس: ${webhookUrl}` : `❌ خطا: ${JSON.stringify(res)}`);
}

async function handleMessage(env, msg) {
  const chat = msg.chat;
  if (!chat || !msg.from) return;
  const text = (msg.text || "").trim();
  const cfg = await getConfig(env);

  if (chat.type === "group" || chat.type === "supergroup") {
    if (text === "/setgroup" || text === "ثبت گروه") {
      const allowed = await isOwnerOrGroupAdmin(env, cfg, chat.id, msg.from.id);
      if (!allowed) return;
      cfg.targetChatId = chat.id;
      cfg.targetChatTitle = chat.title || "گروه اسبدوانی";
      if (!cfg.ownerId) cfg.ownerId = msg.from.id;
      await saveConfig(env, cfg);
      await sendText(
        env.BOT_TOKEN,
        chat.id,
        `✅ گروه <b>${escapeHtml(cfg.targetChatTitle)}</b> ثبت شد!\nبا دستور <b>کورس</b> یا <b>/races</b> منوی دورها را باز کنید.`
      );
      return;
    }

    if (text === "کورس" || text === "کورس ها" || text === "/races") {
      await sendPublicSitesMenu(env, chat.id);
    }
    return;
  }

  if (chat.type !== "private") return;

  if (!cfg.ownerId && !env.OWNER_ID) {
    cfg.ownerId = msg.from.id;
    await saveConfig(env, cfg);
  }
  const isOwner = isBotOwner(env, cfg, msg.from.id);

  if (isOwner) {
    const pending = env.BOT_KV ? await env.BOT_KV.get(`state:${msg.from.id}`) : null;
    if (pending === "await_time" && !text.startsWith("/")) {
      await env.BOT_KV.delete(`state:${msg.from.id}`);
      const norm = normalizeTimeStr(text);
      if (!norm) {
        await sendText(env.BOT_TOKEN, chat.id, "❌ فرمت ساعت اشتباه است! مثال: <code>09:00</code> یا <code>10:30</code>");
        return;
      }
      cfg.scheduleTime = norm;
      await saveConfig(env, cfg);
      await sendText(env.BOT_TOKEN, chat.id, `✅ ساعت بروزرسانی روزانه روی <b>${norm}</b> تنظیم شد.`);
      await sendOwnerPanel(env, chat.id, cfg);
      return;
    }

    if (pending === "await_url" && !text.startsWith("/")) {
      await env.BOT_KV.delete(`state:${msg.from.id}`);
      let newUrl = text.trim();
      if (!/^https?:\/\//i.test(newUrl)) newUrl = `https://${newUrl}`;
      try {
        new URL(newUrl);
        cfg.asbdavaniUrl = newUrl;
        await saveConfig(env, cfg);
        await sendText(env.BOT_TOKEN, chat.id, `✅ لینک ایران تغییر کرد به:\n<code>${escapeHtml(newUrl)}</code>`);
        await sendOwnerPanel(env, chat.id, cfg);
      } catch {
        await sendText(env.BOT_TOKEN, chat.id, "❌ لینک واردشده معتبر نیست.");
      }
      return;
    }
  }

  if (text.startsWith("/start") || text === "پنل" || text === "/panel" || text === "کورس" || text === "/races") {
    if (isOwner) {
      await sendOwnerPanel(env, chat.id, cfg);
    } else {
      await sendPublicSitesMenu(env, chat.id);
    }
  }
}

async function handleCallback(env, ctx, cb) {
  const data = cb.data || "";
  const msg = cb.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const cfg = await getConfig(env);
  const isOwner = isBotOwner(env, cfg, cb.from.id);
  const isPrivateOwner = isOwner && msg.chat.type === "private";

  // --- ۱. ایران ---
  if (data === "site:asbdavani") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    let cache = await getJsonKv(env, "cache:asbdavani");
    if (!cache || !Array.isArray(cache.races) || cache.races.length === 0) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, "⏳ در حال دریافت دورهای <b>asbdavani.app</b>...");
      const res = await refreshAsbdavaniCache(env, cfg);
      if (!res.ok) {
        await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `⚠️ خطا:\n${escapeHtml(res.error)}`, {
          inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_sites" }]]
        });
        return;
      }
      cache = res.cache;
    }
    await editToIranRoundsMenu(env, chatId, msg.message_id, cache, isPrivateOwner);
    return;
  }

  if (data.startsWith("round:asbdavani:")) {
    const idx = parseInt(data.split(":")[2], 10);
    const cache = await getJsonKv(env, "cache:asbdavani");
    const race = cache?.races?.[idx];
    if (!race) {
      await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "اطلاعات قدیمی است؛ بروزرسانی کنید.", show_alert: true });
      return;
    }
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "در حال ارسال..." });
    await sendRaceOutput(env, cfg, chatId, cache.eventTitle || "مسابقات ایران", cfg.asbdavaniUrl, race, async (fileId) => {
      race.photoFileId = fileId;
      await setJsonKv(env, "cache:asbdavani", cache);
    });
    return;
  }

  // --- ۲. ترکیه ---
  if (data === "site:tjk" || data === "back_tjk_cities") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    const today = getTehranNow().dateStr;
    let tjkCache = await getJsonKv(env, "cache:tjk_cities");
    if (!tjkCache || tjkCache.dateStr !== today || !tjkCache.cities?.length) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, "⏳ در حال دریافت پیست‌های امروز ترکیه...");
      const res = await refreshTjkCitiesCache(env, cfg);
      if (!res.ok) {
        await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `⚠️ خطا در ترکیه:\n${escapeHtml(res.error)}`, {
          inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_sites" }]]
        });
        return;
      }
      tjkCache = res.cache;
    }
    await editToTjkCitiesMenu(env, chatId, msg.message_id, tjkCache, isPrivateOwner);
    return;
  }

  if (data.startsWith("tjk_city:")) {
    const cityIdx = parseInt(data.split(":")[1], 10);
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    const citiesCache = await getJsonKv(env, "cache:tjk_cities");
    const city = citiesCache?.cities?.[cityIdx];
    if (!city) return;

    const today = getTehranNow().dateStr;
    let cityCache = await getJsonKv(env, `cache:tjk_city:${cityIdx}`);
    if (!cityCache || cityCache.dateStr !== today || cityCache.cityName !== city.name || !cityCache.races?.length) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `⏳ در حال دریافت کورس‌های <b>${escapeHtml(city.name)}</b>...`);
      const res = await refreshTjkCityRaces(env, cityIdx, city);
      if (!res.ok) {
        await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `⚠️ خطا:\n${escapeHtml(res.error)}`, {
          inline_keyboard: [[{ text: "🔙 بازگشت به شهرها", callback_data: "back_tjk_cities" }]]
        });
        return;
      }
      cityCache = res.cache;
    }
    await editToTjkRoundsMenu(env, chatId, msg.message_id, cityIdx, cityCache, isPrivateOwner);
    return;
  }

  if (data.startsWith("tjk_round:")) {
    const [, cIdx, rIdx] = data.split(":");
    const cityCache = await getJsonKv(env, `cache:tjk_city:${cIdx}`);
    const race = cityCache?.races?.[parseInt(rIdx, 10)];
    if (!race) {
      await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "دور قدیمی است؛ بروزرسانی کنید.", show_alert: true });
      return;
    }
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "در حال ارسال..." });
    await sendRaceOutput(env, cfg, chatId, cityCache.eventTitle, cityCache.siteUrl, race, async (fileId) => {
      race.photoFileId = fileId;
      await setJsonKv(env, `cache:tjk_city:${cIdx}`, cityCache);
    });
    return;
  }

  // --- ۳. اروپا و بین‌الملل ---
  if (data === "site:intl" || data === "back_intl_cities") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    const today = getTehranNow().dateStr;
    let intlCache = await getJsonKv(env, "cache:intl_meetings");
    if (!intlCache || intlCache.dateStr !== today || !intlCache.meetings?.length) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, "⏳ در حال دریافت پیست‌های امروز اروپا و بین‌الملل...");
      const res = await refreshIntlMeetingsCache(env, cfg);
      if (!res.ok) {
        await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `⚠️ خطا در بخش بین‌الملل:\n${escapeHtml(res.error)}`, {
          inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_sites" }]]
        });
        return;
      }
      intlCache = res.cache;
    }
    await editToIntlMeetingsMenu(env, chatId, msg.message_id, intlCache, isPrivateOwner);
    return;
  }

  if (data.startsWith("intl_city:")) {
    const mIdx = parseInt(data.split(":")[1], 10);
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    const intlCache = await getJsonKv(env, "cache:intl_meetings");
    const meeting = intlCache?.meetings?.[mIdx];
    if (!meeting) return;
    await editToIntlRacesMenu(env, chatId, msg.message_id, mIdx, meeting);
    return;
  }

  if (data.startsWith("intl_round:")) {
    const [, mIdxStr, rIdxStr] = data.split(":");
    const mIdx = parseInt(mIdxStr, 10);
    const rIdx = parseInt(rIdxStr, 10);
    const intlCache = await getJsonKv(env, "cache:intl_meetings");
    const meeting = intlCache?.meetings?.[mIdx];
    const raceStub = meeting?.races?.[rIdx];
    if (!raceStub) {
      await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "دور قدیمی است؛ بروزرسانی کنید.", show_alert: true });
      return;
    }
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "در حال آماده‌سازی دور..." });

    const today = getTehranNow().dateStr;
    const cacheKey = `cache:intl_race:${mIdx}:${rIdx}`;
    let raceCache = await getJsonKv(env, cacheKey);

    if (!raceCache || raceCache.dateStr !== today || raceCache.raceUrl !== raceStub.url || !raceCache.race?.horses?.length) {
      const res = await fetchAndParseSingleIntlRace(env, meeting, raceStub, rIdx);
      if (!res.ok) {
        await sendText(env.BOT_TOKEN, chatId, `⚠️ خطا در دریافت دور ${rIdx + 1} (${escapeHtml(meeting.name)}):\n${escapeHtml(res.error)}`);
        return;
      }
      raceCache = { dateStr: today, raceUrl: raceStub.url, race: res.race };
      await setJsonKv(env, cacheKey, raceCache);
    }

    await sendRaceOutput(env, cfg, chatId, `اروپا/بین‌الملل — ${meeting.name}`, raceStub.url, raceCache.race, async (fileId) => {
      raceCache.race.photoFileId = fileId;
      await setJsonKv(env, cacheKey, raceCache);
    });
    return;
  }

  if (data === "back_sites") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    if (isPrivateOwner) {
      await editToOwnerPanel(env, chatId, msg.message_id, cfg);
    } else {
      await editToPublicSitesMenu(env, chatId, msg.message_id);
    }
    return;
  }

  // --- دکمه‌های مدیریتی مالک ---
  if (!isOwner) {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "فقط برای مدیر ربات!", show_alert: true });
    return;
  }

  if (data === "admin_refresh:asbdavani") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "بروزرسانی ایران..." });
    await editMsg(env.BOT_TOKEN, chatId, msg.message_id, "⏳ در حال دریافت کورس‌های ایران...");
    const res = await refreshAsbdavaniCache(env, cfg);
    if (!res.ok) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `❌ خطا:\n${escapeHtml(res.error)}`, {
        inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_sites" }]]
      });
      return;
    }
    await editToIranRoundsMenu(env, chatId, msg.message_id, res.cache, isPrivateOwner);
    return;
  }

  if (data === "admin_refresh:tjk") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "بروزرسانی ترکیه..." });
    await editMsg(env.BOT_TOKEN, chatId, msg.message_id, "⏳ در حال دریافت پیست‌های ترکیه...");
    const res = await refreshTjkCitiesCache(env, cfg);
    if (!res.ok) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `❌ خطا:\n${escapeHtml(res.error)}`, {
        inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_sites" }]]
      });
      return;
    }
    await editToTjkCitiesMenu(env, chatId, msg.message_id, res.cache, isPrivateOwner);
    return;
  }

  if (data === "admin_refresh:intl") {
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "بروزرسانی اروپا..." });
    await editMsg(env.BOT_TOKEN, chatId, msg.message_id, "⏳ در حال دریافت پیست‌های اروپا و بین‌الملل...");
    const res = await refreshIntlMeetingsCache(env, cfg);
    if (!res.ok) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `❌ خطا:\n${escapeHtml(res.error)}`, {
        inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_sites" }]]
      });
      return;
    }
    await editToIntlMeetingsMenu(env, chatId, msg.message_id, res.cache, isPrivateOwner);
    return;
  }

  if (data.startsWith("admin_refresh_tjk_city:")) {
    const cityIdx = parseInt(data.split(":")[1], 10);
    const citiesCache = await getJsonKv(env, "cache:tjk_cities");
    const city = citiesCache?.cities?.[cityIdx];
    if (!city) return;
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "بروزرسانی شهر..." });
    await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `⏳ در حال دریافت دورهای <b>${escapeHtml(city.name)}</b>...`);
    const res = await refreshTjkCityRaces(env, cityIdx, city);
    if (!res.ok) {
      await editMsg(env.BOT_TOKEN, chatId, msg.message_id, `❌ خطا:\n${escapeHtml(res.error)}`, {
        inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: "back_tjk_cities" }]]
      });
      return;
    }
    await editToTjkRoundsMenu(env, chatId, msg.message_id, cityIdx, res.cache, isPrivateOwner);
    return;
  }

  if (data === "admin_send_group") {
    if (!cfg.targetChatId) {
      await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "اول در گروه /setgroup بفرستید!", show_alert: true });
      return;
    }
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "ارسال شد ✅" });
    await sendPublicSitesMenu(env, cfg.targetChatId);
    await sendText(env.BOT_TOKEN, chatId, `✅ منوی دکمه‌ای (ایران + ترکیه + اروپا) به گروه <b>${escapeHtml(cfg.targetChatTitle)}</b> ارسال شد.`);
    return;
  }

  if (data === "admin_set_time") {
    if (env.BOT_KV) await env.BOT_KV.put(`state:${cb.from.id}`, "await_time", { expirationTtl: 300 });
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    await sendText(env.BOT_TOKEN, chatId, "🕒 ساعت بروزرسانی روزانه (به وقت ایران) را بفرستید:\nمثال: <code>09:00</code> یا <code>10:30</code>");
    return;
  }

  if (data === "admin_set_url") {
    if (env.BOT_KV) await env.BOT_KV.put(`state:${cb.from.id}`, "await_url", { expirationTtl: 300 });
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
    await sendText(env.BOT_TOKEN, chatId, `🔗 لینک فعلی ایران:\n<code>${escapeHtml(cfg.asbdavaniUrl)}</code>\n\nلینک جدید را بفرستید:`);
    return;
  }

  if (data === "admin_toggle_auto") {
    cfg.autoSendEnabled = !cfg.autoSendEnabled;
    await saveConfig(env, cfg);
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "تغییر کرد ✅" });
    await editToOwnerPanel(env, chatId, msg.message_id, cfg);
    return;
  }

  if (data === "admin_toggle_image") {
    cfg.imageMode = cfg.imageMode === false;
    await saveConfig(env, cfg);
    await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "حالت خروجی تغییر کرد ✅" });
    await editToOwnerPanel(env, chatId, msg.message_id, cfg);
  }
}

// ================= ارسال عکس جدول یا متن =================

async function sendRaceOutput(env, cfg, chatId, eventTitle, siteUrl, race, onSaveFileId) {
  const useImage = cfg.imageMode !== false && Boolean(env.IMAGE_RENDER_URL);
  if (useImage && Array.isArray(race.horses) && race.horses.length > 0) {
    const caption = buildPhotoCaption(eventTitle, siteUrl, race);

    // ۱. ارسال فوری با file_id کش‌شده
    if (race.photoFileId) {
      const cachedRes = await tg(env.BOT_TOKEN, "sendPhoto", {
        chat_id: chatId,
        photo: race.photoFileId,
        caption,
        parse_mode: "HTML"
      });
      if (cachedRes?.ok) return;
    }

    // ۲. ساخت عکس جدید در Netlify
    try {
      const renderUrl = env.IMAGE_RENDER_URL.trim();
      const headers = { "Content-Type": "application/json" };
      if (env.RENDER_SECRET) headers["x-render-secret"] = env.RENDER_SECRET;

      const renderRes = await fetch(renderUrl, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(18000),
        body: JSON.stringify({
          eventTitle,
          roundNumber: race.roundNumber || "1",
          time: race.time || "",
          title: race.title || "",
          distance: race.distance || "",
          brand: cfg.targetChatTitle || "ربات هوشمند کورس اسبدوانی",
          horses: race.horses
        })
      });

      if (renderRes.ok) {
        const pngBuf = await renderRes.arrayBuffer();
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("photo", new Blob([pngBuf], { type: "image/png" }), "racecard.png");
        form.append("caption", caption);
        form.append("parse_mode", "HTML");

        const tgUpload = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          body: form
        });
        const tgRes = await tgUpload.json();
        if (tgRes?.ok) {
          const photos = tgRes.result?.photo;
          const bestFileId = Array.isArray(photos) && photos.length > 0 ? photos[photos.length - 1].file_id : null;
          if (bestFileId && onSaveFileId) await onSaveFileId(bestFileId);
          return;
        }
      }
    } catch (err) {
      console.error("Image render fallback to text:", err);
    }
  }

  // ۳. حالت متن (اگر حالت متن انتخاب شده باشد یا سرویس عکس پاسخ ندهد)
  await sendLongText(env.BOT_TOKEN, chatId, formatRaceMessage(eventTitle, siteUrl, race));
}

function buildPhotoCaption(eventTitle, siteUrl, race) {
  const roundNum = race.roundNumber || "؟";
  const metaParts = [race.title, race.distance, race.time ? `ساعت ${race.time}` : ""]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const horses = Array.isArray(race.horses) ? race.horses : [];
  const favs = horses
    .filter((h) => h.agf && String(h.agf).trim() !== "—")
    .sort((a, b) => extractAgfNum(b.agf) - extractAgfNum(a.agf))
    .slice(0, 3);

  const lines = [];
  lines.push(`🏁 <b>${escapeHtml(eventTitle)} — دور ${escapeHtml(roundNum)}</b>`);
  if (metaParts.length > 0) lines.push(`📌 ${escapeHtml(metaParts.join(" | "))}`);
  if (favs.length > 0) {
    const favTxt = favs.map((f) => `${escapeHtml(f.name)} (${escapeHtml(f.agf)})`).join(" ، ");
    lines.push(`🔥 <b>برترین‌های AGF:</b> ${favTxt}`);
  }
  lines.push(`🔗 <a href="${escapeHtml(siteUrl)}">مشاهده در سایت</a>`);
  return lines.join("\n").slice(0, 1000);
}

function extractAgfNum(str) {
  const m = /(\d+(?:\.\d+)?)/.exec(String(str || ""));
  return m ? parseFloat(m[1]) : 0;
}

// ================= بخش ۳: اروپا و بین‌الملل =================

async function refreshIntlMeetingsCache(env, cfg) {
  const res = await fetchIntlMeetings(cfg.intlUrl);
  if (!res.ok) return res;
  const now = getTehranNow();
  const cacheObj = { dateStr: now.dateStr, updatedAt: now.fullStr, meetings: res.meetings };
  await setJsonKv(env, "cache:intl_meetings", cacheObj);
  return { ok: true, cache: cacheObj };
}

async function fetchIntlMeetings(primaryUrl) {
  const page = await fetchRawHtml(primaryUrl);
  if (page.ok) {
    const slMeetings = parseSportingLifeMeetings(page.html);
    if (slMeetings.length > 0) return { ok: true, meetings: slMeetings };
  }

  const atrPage = await fetchRawHtml("https://www.attheraces.com/racecards");
  if (atrPage.ok) {
    const atrMeetings = parseAtrMeetings(atrPage.html);
    if (atrMeetings.length > 0) return { ok: true, meetings: atrMeetings };
  }

  return {
    ok: false,
    error: page.ok ? "مسابقه‌ای در صفحه اروپا/بین‌الملل یافت نشد." : page.error
  };
}

function parseSportingLifeMeetings(html) {
  const meetingsMap = new Map();
  const todayUtc = new Date().toISOString().slice(0, 10);

  const nextScript = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nextScript && nextScript[1]) {
    try {
      const parsed = JSON.parse(nextScript[1]);
      const foundMeetings = [];
      collectMeetingsFromJson(parsed, foundMeetings);
      for (const mt of foundMeetings) {
        const slug = mt.slug;
        if (!meetingsMap.has(slug)) {
          meetingsMap.set(slug, { name: mt.name, slug, races: [], seenIds: new Set() });
        }
        const entry = meetingsMap.get(slug);
        for (const r of mt.races) {
          if (!entry.seenIds.has(r.id)) {
            entry.seenIds.add(r.id);
            entry.races.push(r);
          }
        }
      }
    } catch {}
  }

  const urlRegex = /\/racing\/(?:racecards|results)\/(\d{4}-\d{2}-\d{2})\/([a-z0-9-]+)\/(?:racecard\/)?(\d+)\/([a-z0-9-]+)/gi;
  const allMatches = [];
  let m;
  while ((m = urlRegex.exec(html)) !== null) allMatches.push(m);

  const hasToday = allMatches.some((x) => x[1] === todayUtc);
  for (const match of allMatches) {
    const datePart = match[1];
    if (hasToday && datePart !== todayUtc) continue;

    const trackSlug = match[2];
    const raceId = match[3];
    const raceSlug = match[4];
    const canonicalUrl = `https://www.sportinglife.com/racing/racecards/${datePart}/${trackSlug}/racecard/${raceId}/${raceSlug}`;
    const trackName = slugToTitle(trackSlug);

    if (!meetingsMap.has(trackSlug)) {
      meetingsMap.set(trackSlug, { name: trackName, slug: trackSlug, races: [], seenIds: new Set() });
    }
    const meeting = meetingsMap.get(trackSlug);
    if (!meeting.seenIds.has(raceId)) {
      meeting.seenIds.add(raceId);
      const around = html.slice(Math.max(0, match.index - 120), Math.min(html.length, match.index + 260));
      const timeMatch = /\b([012]?\d:[0-5]\d)\b/.exec(around);
      meeting.races.push({ id: raceId, time: timeMatch ? timeMatch[1] : "", url: canonicalUrl });
    }
  }

  return [...meetingsMap.values()]
    .map((x) => ({
      name: x.name,
      slug: x.slug,
      races: x.races.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"))
    }))
    .filter((x) => x.races.length > 0)
    .slice(0, 30);
}

function collectMeetingsFromJson(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectMeetingsFromJson(item, out);
    return;
  }
  if (Array.isArray(node.races) && (node.meeting_summary || node.course || node.name)) {
    const courseName = node.meeting_summary?.course?.name || node.course?.name || node.name || "";
    const dateStr = node.meeting_summary?.date || node.date || new Date().toISOString().slice(0, 10);
    const slug = String(courseName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (courseName && slug) {
      const races = [];
      for (const r of node.races) {
        const rs = r.race_summary || r;
        const raceId = String(rs.race_card_id || rs.id || "");
        const rName = String(rs.name || "race").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (raceId) {
          races.push({
            id: raceId,
            time: rs.time || "",
            url: `https://www.sportinglife.com/racing/racecards/${dateStr}/${slug}/racecard/${raceId}/${rName || "race"}`
          });
        }
      }
      if (races.length > 0) out.push({ name: courseName, slug, races });
    }
  }
  for (const val of Object.values(node)) {
    if (val && typeof val === "object") collectMeetingsFromJson(val, out);
  }
}

function parseAtrMeetings(html) {
  const meetingsMap = new Map();
  const urlRegex = /\/racecard\/([A-Za-z0-9_-]+)\/(\d{1,2}-[A-Za-z]+-\d{4})\/(\d{4})/gi;
  let m;
  while ((m = urlRegex.exec(html)) !== null) {
    const trackSlug = m[1];
    const timeRaw = m[3];
    const timeFmt = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}`;
    const fullUrl = `https://www.attheraces.com${m[0]}`;
    const trackName = slugToTitle(trackSlug);

    if (!meetingsMap.has(trackSlug)) {
      meetingsMap.set(trackSlug, { name: trackName, slug: trackSlug, races: [], seenUrls: new Set() });
    }
    const meeting = meetingsMap.get(trackSlug);
    if (!meeting.seenUrls.has(fullUrl)) {
      meeting.seenUrls.add(fullUrl);
      meeting.races.push({ id: timeRaw, time: timeFmt, url: fullUrl });
    }
  }
  return [...meetingsMap.values()]
    .map((x) => ({
      name: x.name,
      slug: x.slug,
      races: x.races.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"))
    }))
    .filter((x) => x.races.length > 0)
    .slice(0, 30);
}

async function fetchAndParseSingleIntlRace(env, meeting, raceStub, rIdx) {
  const page = await fetchRawHtml(raceStub.url);
  if (!page.ok) return page;

  const directRace = parseSportingLifeRaceFromNextData(page.html, meeting.name, raceStub, rIdx);
  if (directRace && directRace.horses.length > 0) {
    return { ok: true, race: directRace };
  }

  if (!hasAiKey(env)) {
    return { ok: false, error: "کلید هوش مصنوعی ثبت نشده است." };
  }

  const nextData = extractNextDataText(page.html);
  const readable = htmlToReadableText(page.html);
  const combined = nextData
    ? `--- NEXT_DATA ---\n${nextData.slice(0, 30000)}\n\n--- HTML ---\n${readable.slice(0, 12000)}`
    : readable.slice(0, 35000);

  const aiRes = await extractStructuredRaces(env, raceStub.url, combined, `${meeting.name} — دور ${rIdx + 1}`);
  const firstRace = aiRes.data?.races?.[0];
  if (!firstRace || !firstRace.horses?.length) {
    return { ok: false, error: aiRes.error || "لیست اسب‌های این دور استخراج نشد." };
  }

  if (!firstRace.roundNumber) firstRace.roundNumber = rIdx + 1;
  if (!firstRace.time && raceStub.time) firstRace.time = raceStub.time;
  return { ok: true, race: firstRace };
}

function oddsToAgfStr(oddsRaw) {
  const s = String(oddsRaw || "").trim();
  if (!s) return "";
  if (/^(evens|evs)$/i.test(s)) return "%50";
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (frac) {
    const num = parseFloat(frac[1]);
    const den = parseFloat(frac[2]);
    if (num + den > 0) {
      const pct = Math.round((den / (num + den)) * 100);
      return `%${pct}`;
    }
  }
  return s;
}

function parseSportingLifeRaceFromNextData(html, meetingName, raceStub, rIdx) {
  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m || !m[1]) return null;
  try {
    const root = JSON.parse(m[1]);
    const found = { rides: null, summary: null };
    findRacePayload(root, found);
    if (!Array.isArray(found.rides) || found.rides.length === 0) return null;

    const horses = found.rides.map((ride, idx) => ({
      number: String(ride.cloth_number ?? ride.saddle_cloth ?? idx + 1),
      gate: ride.draw_number ? String(ride.draw_number) : "",
      name: ride.horse?.name || ride.horse_name || "نامشخص",
      owner: ride.owner?.name || ride.owner_name || "",
      trainer: ride.trainer?.name || ride.trainer_name || "",
      jockey: ride.jockey?.name || ride.jockey_name || "",
      agf: oddsToAgfStr(ride.betting?.current_odds || ride.forecast_odds || ride.odds || "")
    }));

    return {
      roundNumber: rIdx + 1,
      title: found.summary?.name || `پیست ${meetingName}`,
      distance: found.summary?.distance || "",
      time: found.summary?.time || raceStub.time || "",
      horses
    };
  } catch {
    return null;
  }
}

function findRacePayload(node, found) {
  if (!node || typeof node !== "object") return;
  if (!found.summary && node.race_summary && node.race_summary.name) {
    found.summary = node.race_summary;
  }
  if (!found.rides && Array.isArray(node.rides) && node.rides.length > 0 && node.rides[0]?.horse) {
    found.rides = node.rides;
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) findRacePayload(item, found);
  } else {
    for (const val of Object.values(node)) {
      if (val && typeof val === "object") findRacePayload(val, found);
    }
  }
}

function slugToTitle(slug) {
  return String(slug || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

// ================= بخش ۲: ترکیه (TJK) =================

async function refreshTjkCitiesCache(env, cfg) {
  const res = await fetchTjkCities(cfg.tjkUrl);
  if (!res.ok) return res;
  const now = getTehranNow();
  const cacheObj = { dateStr: now.dateStr, updatedAt: now.fullStr, cities: res.cities };
  await setJsonKv(env, "cache:tjk_cities", cacheObj);
  return { ok: true, cache: cacheObj };
}

async function fetchTjkCities(tjkMainUrl) {
  const page = await fetchRawHtml(tjkMainUrl);
  if (!page.ok) return page;

  const html = page.html;
  const cities = [];
  const seenIds = new Set();

  const linkRegex = /<a[^>]+href=["']([^"']*\/TR\/YarisSever\/Info\/Sehir\/GunlukYarisProgrami[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const rawHref = m[1].replace(/&amp;/g, "&");
    const fullUrl = rawHref.startsWith("http") ? rawHref : `https://www.tjk.org${rawHref.startsWith("/") ? "" : "/"}${rawHref}`;
    try {
      const u = new URL(fullUrl);
      const sehirId = u.searchParams.get("SehirId") || "";
      const sehirAdi = u.searchParams.get("SehirAdi") || "";
      const innerText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const cityName = (sehirAdi || innerText || `پیست ${cities.length + 1}`).trim();
      const key = sehirId || cityName;
      if (key && !seenIds.has(key)) {
        seenIds.add(key);
        cities.push({ id: sehirId, name: cityName, url: u.toString() });
      }
    } catch {}
  }

  if (cities.length === 0) {
    const urlOnlyRegex = /\/TR\/YarisSever\/Info\/Sehir\/GunlukYarisProgrami\?[^"'\s<>]+/gi;
    let uMatch;
    while ((uMatch = urlOnlyRegex.exec(html)) !== null) {
      const fullUrl = `https://www.tjk.org${uMatch[0].replace(/&amp;/g, "&")}`;
      try {
        const u = new URL(fullUrl);
        const sehirId = u.searchParams.get("SehirId") || "";
        const sehirAdi = u.searchParams.get("SehirAdi") || `پیست ${cities.length + 1}`;
        if (!seenIds.has(sehirId || sehirAdi)) {
          seenIds.add(sehirId || sehirAdi);
          cities.push({ id: sehirId, name: sehirAdi, url: u.toString() });
        }
      } catch {}
    }
  }

  if (cities.length === 0 && parseTjkHtmlTables(html, "مسابقات ترکیه").length > 0) {
    cities.push({ id: "main", name: "مسابقات امروز ترکیه", url: tjkMainUrl });
  }

  if (cities.length === 0) return { ok: false, error: "امروز مسابقه‌ای در TJK پیدا نشد." };
  return { ok: true, cities };
}

async function refreshTjkCityRaces(env, cityIdx, city) {
  const page = await fetchRawHtml(city.url);
  if (!page.ok) return page;

  let races = parseTjkHtmlTables(page.html, city.name);
  if (races.length === 0 && hasAiKey(env)) {
    const readable = htmlToReadableText(page.html).slice(0, 40000);
    const aiRes = await extractStructuredRaces(env, city.url, readable, `ترکیه — ${city.name}`);
    if (aiRes.data?.races?.length) races = aiRes.data.races;
  }

  if (races.length === 0) {
    return { ok: false, error: `هیچ دور و اسبی برای ${city.name} استخراج نشد.` };
  }

  races.sort((a, b) => (Number(a.roundNumber) || 0) - (Number(b.roundNumber) || 0));
  const now = getTehranNow();
  const cacheObj = {
    dateStr: now.dateStr,
    updatedAt: now.fullStr,
    cityName: city.name,
    eventTitle: `ترکیه — پیست ${city.name}`,
    siteUrl: city.url,
    races
  };
  await setJsonKv(env, `cache:tjk_city:${cityIdx}`, cacheObj);
  return { ok: true, cache: cacheObj };
}

function parseTjkHtmlTables(html, cityName) {
  const races = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let currentRace = null;
  let cols = null;
  let autoRound = 1;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells = [...trMatch[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => cleanCellText(c[1]));
    if (cells.length === 0) continue;

    const fName = cells.findIndex((c) => /at\s*[iİı]sm[iİı]/i.test(c));
    const fJockey = cells.findIndex((c) => /jokey/i.test(c));
    if (cells.length >= 4 && fName !== -1 && fJockey !== -1) {
      if (currentRace && currentRace.horses.length > 0) races.push(currentRace);

      cols = {
        name: fName,
        jockey: fJockey,
        owner: cells.findIndex((c) => /sah[iİı]p/i.test(c)),
        trainer: cells.findIndex((c) => /antren[oö]r/i.test(c)),
        gate: cells.findIndex((c) => /^st\.?$/i.test(c)),
        agf: cells.findIndex((c) => /\bagf\b/i.test(c))
      };

      const preText = cleanCellText(html.slice(Math.max(0, trMatch.index - 5500), trMatch.index));
      const roundMatches = [...preText.matchAll(/(\d+)\.\s*Ko[sş]u/gi)];
      const roundNum = roundMatches.length ? parseInt(roundMatches[roundMatches.length - 1][1], 10) : autoRound;
      const timeMatches = [...preText.matchAll(/Saat\s*[:：]?\s*(\d{1,2}[:.]\d{2})/gi)];
      const raceTime = timeMatches.length ? timeMatches[timeMatches.length - 1][1].replace(".", ":") : "";
      const distMatches = [...preText.matchAll(/(\d{3,4})\s*(?:m\.?\s*)?(Çim|Kum|Sentetik)/gi)];
      let distance = "";
      if (distMatches.length) {
        const d = distMatches[distMatches.length - 1];
        const s = d[2].toLowerCase();
        distance = `${d[1]} متر ${s.includes("çim") ? "چمن" : s.includes("kum") ? "خاکی" : "سنتتیک"}`;
      }

      currentRace = { roundNumber: roundNum, title: `پیست ${cityName}`, distance, time: raceTime, horses: [] };
      autoRound = roundNum + 1;
      continue;
    }

    if (currentRace && cols && cells.length > cols.name) {
      const rawHorse = cells[cols.name] || "";
      if (!rawHorse || /toplam|koşmaz|at\s*[iİı]sm/i.test(rawHorse)) continue;
      const numMatch = /^(\d+)\s*[.\-)]\s*(.+)$/.exec(rawHorse);
      currentRace.horses.push({
        number: numMatch ? numMatch[1] : String(currentRace.horses.length + 1),
        gate: cols.gate >= 0 && cells[cols.gate] ? cells[cols.gate] : "",
        name: numMatch ? numMatch[2].trim() : rawHorse,
        owner: cols.owner >= 0 && cells[cols.owner] ? cells[cols.owner] : "",
        trainer: cols.trainer >= 0 && cells[cols.trainer] ? cells[cols.trainer] : "",
        jockey: cols.jockey >= 0 && cells[cols.jockey] ? cells[cols.jockey] : "",
        agf: cols.agf >= 0 && cells[cols.agf] ? cells[cols.agf] : ""
      });
    }
  }

  if (currentRace && currentRace.horses.length > 0) races.push(currentRace);
  return races;
}

function cleanCellText(fragment) {
  return String(fragment || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

// ================= بخش ۱: ایران =================

async function refreshAsbdavaniCache(env, cfg) {
  if (!hasAiKey(env)) return { ok: false, error: "کلید هوش مصنوعی ثبت نشده است." };
  const page = await fetchRawHtml(cfg.asbdavaniUrl);
  if (!page.ok) return page;

  const nextData = extractNextDataText(page.html);
  const cleaned = htmlToReadableText(page.html);
  const combined = nextData
    ? `--- STRUCTURED_NEXT_DATA ---\n${nextData.slice(0, 45000)}\n\n--- HTML_TEXT ---\n${cleaned.slice(0, 15000)}`
    : cleaned;

  if (combined.length < 220) return { ok: false, error: "صفحه خالی است." };

  const aiRes = await extractStructuredRaces(env, cfg.asbdavaniUrl, combined.slice(0, 60000), "مسابقات ایران");
  if (!aiRes.data) return { ok: false, error: aiRes.error || "خطای تحلیل" };

  const races = Array.isArray(aiRes.data.races) ? aiRes.data.races : [];
  if (races.length === 0) return { ok: false, error: aiRes.data.note || "هیچ دوری پیدا نشد." };

  races.sort((a, b) => (Number(a.roundNumber) || 0) - (Number(b.roundNumber) || 0));
  const cacheObj = {
    updatedAt: getTehranNow().fullStr,
    eventTitle: aiRes.data.eventTitle || "مسابقات ایران",
    siteUrl: cfg.asbdavaniUrl,
    races
  };
  await setJsonKv(env, "cache:asbdavani", cacheObj);
  return { ok: true, cache: cacheObj };
}

// ================= منوها و متن پشتیبان =================

function formatRaceMessage(eventTitle, siteUrl, race) {
  const roundNum = race.roundNumber || "؟";
  const metaParts = [race.title, race.distance, race.time ? `ساعت ${race.time}` : ""]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const lines = [];
  lines.push(`🏁 <b>${escapeHtml(eventTitle)} — دور ${escapeHtml(roundNum)}</b>`);
  if (metaParts.length > 0) lines.push(`📌 ${escapeHtml(metaParts.join(" | "))}`);
  lines.push("");

  const horses = Array.isArray(race.horses) ? race.horses : [];
  if (horses.length === 0) {
    lines.push("⏳ لیست اسب‌های این دور هنوز ثبت نشده است.");
  } else {
    horses.forEach((h, idx) => {
      const tags = [h.number ? `شماره ${h.number}` : "", h.gate ? `دپار ${h.gate}` : ""].filter(Boolean).join(" / ");
      lines.push(`<b>${idx + 1}. ${escapeHtml(h.name || "نامشخص")}</b>${tags ? ` (${escapeHtml(tags)})` : ""}`);
      lines.push(`👤 مالک: ${escapeHtml(h.owner || "نامشخص")}`);
      lines.push(`🧑‍🏫 مربی: ${escapeHtml(h.trainer || "نامشخص")}`);
      lines.push(`🏇 چابکسوار: ${escapeHtml(h.jockey || "نامشخص")}`);
      if (h.agf) lines.push(`📊 AGF / شانس: <b>${escapeHtml(h.agf)}</b>`);
      lines.push("");
    });
  }
  lines.push(`🔗 <a href="${escapeHtml(siteUrl)}">مشاهده در سایت</a>`);
  return lines.join("\n").trim();
}

async function editToIranRoundsMenu(env, chatId, msgId, cache, showRefreshBtn) {
  const rows = buildRoundRows(cache.races || [], "round:asbdavani:");
  if (showRefreshBtn) rows.push([{ text: "🔄 بروزرسانی مجدد ایران", callback_data: "admin_refresh:asbdavani" }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "back_sites" }]);
  await editMsg(env.BOT_TOKEN, chatId, msgId, `🇮🇷 <b>${escapeHtml(cache.eventTitle)}</b>\n🕒 ${escapeHtml(cache.updatedAt)}\n\n👇 روی شماره <b>دور</b> بزنید:`, { inline_keyboard: rows });
}

async function editToTjkCitiesMenu(env, chatId, msgId, tjkCache, showRefreshBtn) {
  const rows = buildChunkedButtons(tjkCache.cities || [], (c, i) => ({ text: `🏟 ${c.name}`, callback_data: `tjk_city:${i}` }));
  if (showRefreshBtn) rows.push([{ text: "🔄 بروزرسانی شهرهای ترکیه", callback_data: "admin_refresh:tjk" }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "back_sites" }]);
  await editMsg(env.BOT_TOKEN, chatId, msgId, `🇹🇷 <b>مسابقات امروز ترکیه (TJK)</b>\n🕒 ${escapeHtml(tjkCache.updatedAt)}\n\n👇 پیست / شهر موردنظر را انتخاب کنید:`, { inline_keyboard: rows });
}

async function editToTjkRoundsMenu(env, chatId, msgId, cityIdx, cityCache, showRefreshBtn) {
  const rows = buildRoundRows(cityCache.races || [], `tjk_round:${cityIdx}:`);
  if (showRefreshBtn) rows.push([{ text: `🔄 بروزرسانی ${cityCache.cityName}`, callback_data: `admin_refresh_tjk_city:${cityIdx}` }]);
  rows.push([{ text: "🔙 بازگشت به شهرهای ترکیه", callback_data: "back_tjk_cities" }]);
  await editMsg(env.BOT_TOKEN, chatId, msgId, `🇹🇷 <b>${escapeHtml(cityCache.eventTitle)}</b>\n🕒 ${escapeHtml(cityCache.updatedAt)}\n\n👇 روی شماره <b>دور</b> بزنید:`, { inline_keyboard: rows });
}

async function editToIntlMeetingsMenu(env, chatId, msgId, intlCache, showRefreshBtn) {
  const rows = buildChunkedButtons(intlCache.meetings || [], (m, i) => ({ text: `🏟 ${m.name} (${m.races.length})`, callback_data: `intl_city:${i}` }));
  if (showRefreshBtn) rows.push([{ text: "🔄 بروزرسانی لیست اروپا", callback_data: "admin_refresh:intl" }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "back_sites" }]);
  await editMsg(env.BOT_TOKEN, chatId, msgId, `🌍 <b>مسابقات اروپا و بین‌الملل</b>\n🕒 ${escapeHtml(intlCache.updatedAt)}\n\n👇 پیست موردنظر را انتخاب کنید:`, { inline_keyboard: rows });
}

async function editToIntlRacesMenu(env, chatId, msgId, mIdx, meeting) {
  const rows = buildChunkedButtons(meeting.races || [], (r, i) => ({
    text: `🏁 دور ${i + 1}${r.time ? ` (${r.time})` : ""}`,
    callback_data: `intl_round:${mIdx}:${i}`
  }));
  rows.push([{ text: "🔙 بازگشت به پیست‌های اروپا", callback_data: "back_intl_cities" }]);
  await editMsg(env.BOT_TOKEN, chatId, msgId, `🌍 <b>پیست ${escapeHtml(meeting.name)}</b>\n\n👇 روی شماره <b>دور</b> بزنید:`, { inline_keyboard: rows });
}

function buildChunkedButtons(list, mapper) {
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [mapper(list[i], i)];
    if (i + 1 < list.length) row.push(mapper(list[i + 1], i + 1));
    rows.push(row);
  }
  return rows;
}

function buildRoundRows(races, prefix) {
  return buildChunkedButtons(races, (r, i) => ({
    text: `🏁 دور ${r.roundNumber || i + 1}${r.time ? ` (${r.time})` : ""}`,
    callback_data: `${prefix}${i}`
  }));
}

async function sendPublicSitesMenu(env, chatId) {
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: "🐎 <b>برنامه کورس‌های اسبدوانی</b>\n\nمنطقه / سایت موردنظر را انتخاب کنید:",
    parse_mode: "HTML",
    reply_markup: buildPublicSitesMarkup()
  });
}

async function editToPublicSitesMenu(env, chatId, msgId) {
  await editMsg(env.BOT_TOKEN, chatId, msgId, "🐎 <b>برنامه کورس‌های اسبدوانی</b>\n\nمنطقه / سایت موردنظر را انتخاب کنید:", buildPublicSitesMarkup());
}

function buildPublicSitesMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🇮🇷 مسابقات ایران (asbdavani.app)", callback_data: "site:asbdavani" }],
      [{ text: "🇹🇷 مسابقات ترکیه (tjk.org)", callback_data: "site:tjk" }],
      [{ text: "🌍 اروپا و بین‌الملل (UK/EU/US)", callback_data: "site:intl" }]
    ]
  };
}

async function sendOwnerPanel(env, chatId, cfg) {
  const asb = await getJsonKv(env, "cache:asbdavani");
  const tjk = await getJsonKv(env, "cache:tjk_cities");
  const intl = await getJsonKv(env, "cache:intl_meetings");
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: buildOwnerPanelText(env, cfg, asb, tjk, intl),
    parse_mode: "HTML",
    reply_markup: buildOwnerPanelMarkup(cfg)
  });
}

async function editToOwnerPanel(env, chatId, msgId, cfg) {
  const asb = await getJsonKv(env, "cache:asbdavani");
  const tjk = await getJsonKv(env, "cache:tjk_cities");
  const intl = await getJsonKv(env, "cache:intl_meetings");
  await editMsg(env.BOT_TOKEN, chatId, msgId, buildOwnerPanelText(env, cfg, asb, tjk, intl), buildOwnerPanelMarkup(cfg));
}

function buildOwnerPanelText(env, cfg, asb, tjk, intl) {
  const groupText = cfg.targetChatId ? `✅ ${escapeHtml(cfg.targetChatTitle)}` : "❌ ثبت نشده (<b>/setgroup</b>)";
  const imgStatus = env.IMAGE_RENDER_URL ? (cfg.imageMode !== false ? "عکس جدول 🖼" : "متن 📝") : "⚠️ IMAGE_RENDER_URL ست نشده";
  return (
    "🐎 <b>پنل مدیریت ربات کورس‌ها</b>\n\n" +
    `👥 <b>گروه مقصد:</b> ${groupText}\n` +
    `🇮🇷 ایران: ${asb?.races?.length || 0} دور | 🇹🇷 ترکیه: ${tjk?.cities?.length || 0} شهر | 🌍 اروپا: ${intl?.meetings?.length || 0} پیست\n` +
    `🎨 <b>نوع خروجی:</b> ${imgStatus}\n` +
    `⏰ <b>ساعت خودکار:</b> ${cfg.scheduleTime} (${cfg.autoSendEnabled ? "روشن ✅" : "خاموش ❌"})`
  );
}

function buildOwnerPanelMarkup(cfg) {
  return {
    inline_keyboard: [
      [
        { text: "🇮🇷 ایران", callback_data: "site:asbdavani" },
        { text: "🇹🇷 ترکیه", callback_data: "site:tjk" },
        { text: "🌍 اروپا", callback_data: "site:intl" }
      ],
      [
        { text: "🔄 آپدیت ایران", callback_data: "admin_refresh:asbdavani" },
        { text: "🔄 آپدیت ترکیه", callback_data: "admin_refresh:tjk" },
        { text: "🔄 آپدیت اروپا", callback_data: "admin_refresh:intl" }
      ],
      [
        { text: "📢 ارسال منو به گروه", callback_data: "admin_send_group" },
        { text: cfg.imageMode !== false ? "🖼 حالت: عکس" : "📝 حالت: متن", callback_data: "admin_toggle_image" }
      ],
      [
        { text: `🕒 ساعت (${cfg.scheduleTime})`, callback_data: "admin_set_time" },
        { text: cfg.autoSendEnabled ? "⏸ خاموش خودکار" : "▶️ روشن خودکار", callback_data: "admin_toggle_auto" }
      ],
      [{ text: "🔗 تغییر لینک ایران", callback_data: "admin_set_url" }]
    ]
  };
}

// ================= توابع پایه =================

async function fetchRawHtml(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9,fa-IR,fa;q=0.8,tr-TR;q=0.7"
      }
    });
    if (!res.ok) return { ok: false, error: `سایت پاسخ نداد (کد ${res.status})` };
    return { ok: true, html: await res.text() };
  } catch (err) {
    return { ok: false, error: `خطای شبکه: ${err.message}` };
  }
}

function extractNextDataText(html) {
  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (m && m[1]) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed?.props?.pageProps) return JSON.stringify(parsed.props.pageProps);
    } catch {}
  }
  const chunks = [];
  const marker = 'self.__next_f.push([1,"';
  let pos = 0;
  while (true) {
    const start = html.indexOf(marker, pos);
    if (start === -1) break;
    let i = start + marker.length, escaped = false;
    while (i < html.length) {
      const ch = html[i];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') break;
      i++;
    }
    const rawLiteral = html.slice(start + marker.length, i);
    pos = i + 1;
    try {
      const decoded = JSON.parse(`"${rawLiteral}"`);
      if (/دور|مالک|مربی|چابکسوار|اسبدوانی|race|horse|jockey|trainer|owner/i.test(decoded)) {
        chunks.push(decoded);
      }
    } catch {}
  }
  return chunks.join("\n");
}

function htmlToReadableText(html) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " || ")
    .replace(/<\/(a|span|div|p|li|h1|h2|h3|h4|section|article|strong|b|small)>/gi, " · ")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/(?:·\s*){2,}/g, "· ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function extractStructuredRaces(env, siteUrl, rawText, defaultTitle) {
  const sys = `تو متخصص استخراج دقیق داده‌های مسابقات اسبدوانی هستی.
تمامی کورس‌ها (دور ۱ تا آخر) را کامل از متن استخراج کن و دقیقاً فقط یک JSON معتبر برگردان:
{
  "eventTitle": "${defaultTitle}",
  "races": [
    {
      "roundNumber": 1,
      "title": "عنوان یا کلاس و نژاد کورس",
      "distance": "مسافت (به فارسی بنویس)",
      "time": "ساعت شروع یا خالی",
      "horses": [
        {
          "number": "شماره اسب",
          "gate": "شماره دپار یا خالی",
          "name": "نام اسب",
          "owner": "نام مالک",
          "trainer": "نام مربی",
          "jockey": "نام چابکسوار",
          "agf": "درصد نظرسنجی/شانس یا امتیاز محبوبیت (مثل %42(1)) یا خالی"
        }
      ]
    }
  ],
  "note": "توضیح کوتاه اگر جدولی نبود"
}
قوانین مهم:
1. ستون «مالک / مربی / چابکسوار» در سایت ایرانی با · جدا شده است؛ به ترتیب اول مالک، دوم مربی و سوم چابکسوار است.
2. در سایت‌های انگلیسی: Owner=مالک، Trainer=مربی، Jockey=چابکسوار، Draw=دپار.
3. هیچ اسب یا اسمی را از خودت نساز! اگر موردی در متن نبود مقدارش را "" بگذار.`;

  const user = `آدرس: ${siteUrl}\n\nداده‌های صفحه:\n${rawText}`;
  const res = await callBestAi(env, sys, user, 8192, true);
  if (!res.text) return { data: null, error: res.error };

  try {
    return { data: JSON.parse(extractPureJson(res.text)), error: null };
  } catch (err) {
    return { data: null, error: `خطای JSON: ${err.message}` };
  }
}

function extractPureJson(raw) {
  const fence = "\u0060\u0060\u0060";
  let text = String(raw || "").trim();
  if (text.startsWith(fence)) {
    text = text.replace(/^\u0060\u0060\u0060(?:json)?/i, "").replace(/\u0060\u0060\u0060$/, "").trim();
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

async function callBestAi(env, systemPrompt, userPrompt, maxTokens, jsonMode = false) {
  let lastError = null;

  if (env.GEMINI_API_KEY) {
    for (const model of ["gemini-4-hydrogen", "gemini-3.5-flash-lite"]) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY.trim(), "Content-Type": "application/json" },
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
        if (text) return { text, error: null };
      } else {
        lastError = `Gemini ${model} (${res.status})`;
      }
    }
  }

  if (env.GROQ_API_KEY) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen/qwen3.8-27b",
        reasoning_effort: "none",
        temperature: 0.1,
        max_tokens: Math.min(maxTokens, 4096),
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt.slice(0, 6500) }
        ]
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return { text, error: null };
    } else {
      lastError = `Groq (${res.status})`;
    }
  }

  return { text: null, error: lastError || "خطای نامشخص" };
}

function isBotOwner(env, cfg, userId) {
  if (env.OWNER_ID) return String(userId) === String(env.OWNER_ID);
  if (cfg.ownerId) return String(userId) === String(cfg.ownerId);
  return false;
}

async function isOwnerOrGroupAdmin(env, cfg, chatId, userId) {
  if (isBotOwner(env, cfg, userId)) return true;
  const res = await tg(env.BOT_TOKEN, "getChatMember", { chat_id: chatId, user_id: userId });
  const status = res?.result?.status;
  return status === "creator" || status === "administrator";
}

function normalizeTimeStr(raw) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const roundedMin = min >= 30 ? 30 : 0;
  return `${String(h).padStart(2, "0")}:${String(roundedMin).padStart(2, "0")}`;
}

function getTehranNow() {
  const d = new Date(Date.now() + 3.5 * 60 * 60 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = d.getUTCMinutes() >= 30 ? "30" : "00";
  const realMm = String(d.getUTCMinutes()).padStart(2, "0");
  const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { hhmm: `${hh}:${mm}`, dateStr, fullStr: `${dateStr} ${hh}:${realMm}` };
}

function hasAiKey(env) {
  return Boolean(env.GEMINI_API_KEY || env.GROQ_API_KEY);
}

async function getConfig(env) {
  const base = { ...DEFAULT_CONFIG };
  if (!env.BOT_KV) return base;
  const raw = await env.BOT_KV.get("config:main");
  if (!raw) return base;
  try {
    return { ...base, ...JSON.parse(raw) };
  } catch {
    return base;
  }
}

async function saveConfig(env, cfg) {
  if (!env.BOT_KV) return;
  await env.BOT_KV.put("config:main", JSON.stringify(cfg));
}

async function getJsonKv(env, key) {
  if (!env.BOT_KV) return null;
  const raw = await env.BOT_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJsonKv(env, key, data) {
  if (!env.BOT_KV) return;
  await env.BOT_KV.put(key, JSON.stringify(data));
}

async function sendLongText(token, chatId, fullText) {
  const MAX = 3800;
  if (fullText.length <= MAX) {
    await sendText(token, chatId, fullText);
    return;
  }
  const lines = fullText.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > MAX) {
      if (chunk.trim()) await sendText(token, chatId, chunk.trim());
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk.trim()) await sendText(token, chatId, chunk.trim());
}

async function sendText(token, chatId, text) {
  return tg(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function editMsg(token, chatId, messageId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tg(token, "editMessageText", payload);
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function textRes(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
