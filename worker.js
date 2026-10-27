export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // 1. Вебхук Telegram
      if (url.pathname === "/webhook/telegram" && request.method === "POST") {
        const update = await request.json();
        await handleTelegramUpdate(update, env, url.origin);
        return new Response("OK", { status: 200 });
      }

      // 2. Вебхук ЮKassa
      if (url.pathname === "/webhook/yookassa" && request.method === "POST") {
        const body = await request.json();
        await handleYooKassaWebhook(body, env);
        return new Response("OK", { status: 200 });
      }

      // 3. Вебхук Tribute
      if (url.pathname === "/webhook/tribute" && request.method === "POST") {
        const rawBody = await request.text();
        const signature = request.headers.get("trbt-signature") || "";
        const isValid = await verifyTributeSignature(rawBody, signature, env.TRIBUTE_API_KEY);

        if (!isValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        const body = JSON.parse(rawBody);
        await handleTributeWebhook(body, env);
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 4. Служебный эндпоинт для быстрой установки вебхука Telegram
      if (url.pathname === "/setup") {
        const webhookUrl = `${url.origin}/webhook/telegram`;
        const res = await tgApi(env.BOT_TOKEN, "setWebhook", {
          url: webhookUrl,
          allowed_updates: ["message", "callback_query", "my_chat_member"]
        });
        return new Response(JSON.stringify(res, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Service is running.", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("Internal Error", { status: 500 });
    }
  }
};

/* ============================================================================
   ОБРАБОТКА ОБНОВЛЕНИЙ TELEGRAM
============================================================================ */

async function handleTelegramUpdate(update, env, origin) {
  // Автоматическое определение добавления бота в канал
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    const chat = m.chat;
    const fromId = m.from.id;
    const newStatus = m.new_chat_member?.status;

    if (chat.type === "channel" && isAdmin(fromId, env) && newStatus === "administrator") {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: fromId,
        text: `Бот добавлен как администратор в канал:\n<b>${escapeHtml(chat.title)}</b>\nID канала: <code>${chat.id}</code>\n\nНажмите кнопку ниже, чтобы сделать этот канал основным для выдачи одноразовых ссылок.`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Установить этот канал основным", callback_data: `adm_set_ch:${chat.id}` }]
          ]
        }
      });
    }
    return;
  }

  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, env, origin);
  }
}

/* ============================================================================
   ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ И СОСТОЯНИЙ АДМИН-ПАНЕЛИ
============================================================================ */

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  if (msg.chat.type !== "private") return;

  // Команда /admin
  if (text === "/admin" && isAdmin(userId, env)) {
    await clearAdminState(env, userId);
    await showAdminMenu(chatId, null, env);
    return;
  }

  // Команда /start
  if (text.startsWith("/start")) {
    await clearAdminState(env, userId);
    await showUserMainMenu(chatId, null, env);
    return;
  }

  // Проверка активного состояния ввода у администратора
  if (isAdmin(userId, env)) {
    const stateRow = await env.DB.prepare("SELECT state, temp_data FROM admin_states WHERE user_id = ?")
      .bind(userId)
      .first();

    if (stateRow) {
      await processAdminInput(msg, stateRow.state, JSON.parse(stateRow.temp_data || "{}"), env);
      return;
    }
  }

  await showUserMainMenu(chatId, null, env);
}

/* ============================================================================
   ПОЛЬЗОВАТЕЛЬСКОЕ МЕНЮ
============================================================================ */

async function showUserMainMenu(chatId, messageId, env) {
  const settings = await getSettings(env);
  const { results: tariffs } = await env.DB.prepare(
    "SELECT * FROM tariffs WHERE is_active = 1 ORDER BY id ASC"
  ).all();

  const keyboard = [];
  for (const t of tariffs) {
    keyboard.push([
      {
        text: `${t.name} — ${t.price} руб.`,
        callback_data: `view_tariff:${t.id}`
      }
    ]);
  }

  keyboard.push([{ text: "По вопросам и поддержке", callback_data: "support_info" }]);

  const text = `<b>${escapeHtml(settings.bot_title)}</b>\n\n${escapeHtml(settings.bot_description)}`;

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function showTariffDetails(chatId, messageId, tariffId, env) {
  const tariff = await env.DB.prepare("SELECT * FROM tariffs WHERE id = ? AND is_active = 1")
    .bind(tariffId)
    .first();

  if (!tariff) {
    await sendOrEdit(env, chatId, messageId, "Тариф не найден или недоступен.", [
      [{ text: "Назад в меню", callback_data: "main_menu" }]
    ]);
    return;
  }

  const text =
    `<b>${escapeHtml(tariff.name)}</b>\n\n` +
    `${escapeHtml(tariff.description)}\n\n` +
    `Стоимость: <b>${tariff.price} руб.</b>\n\n` +
    `Выберите способ оплаты. Сразу после подтверждения платежа бот сгенерирует и отправит вам персональную одноразовую ссылку для входа в канал.`;

  const keyboard = [];

  const yookassaConfigured =
    env.YOOKASSA_SHOP_ID &&
    env.YOOKASSA_SHOP_ID !== "0" &&
    env.YOOKASSA_SECRET_KEY &&
    env.YOOKASSA_SECRET_KEY !== "0";

  if (yookassaConfigured) {
    keyboard.push([
      { text: `Оплатить через ЮKassa (${tariff.price} руб.)`, callback_data: `pay_yk:${tariff.id}` }
    ]);
  }

  if (tariff.tribute_url) {
    keyboard.push([
      { text: `Оплатить через Tribute (${tariff.price} руб.)`, callback_data: `pay_trb:${tariff.id}` }
    ]);
  }

  keyboard.push([{ text: "Назад в меню", callback_data: "main_menu" }]);

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function showSupportInfo(chatId, messageId, env) {
  const settings = await getSettings(env);
  const contactUrl = formatContactUrl(settings.support_contact);

  const text =
    `<b>По вопросам и поддержке</b>\n\n` +
    `${escapeHtml(settings.support_text)}\n\n` +
    `Контакт для связи: ${escapeHtml(settings.support_contact)}`;

  const keyboard = [];
  if (contactUrl) {
    keyboard.push([{ text: "Написать в поддержку", url: contactUrl }]);
  }
  keyboard.push([{ text: "Назад в меню", callback_data: "main_menu" }]);

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

/* ============================================================================
   ОБРАБОТКА CALLBACK-КНОПОК
============================================================================ */

async function handleCallback(cb, env, origin) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const userId = cb.from.id;
  const data = cb.data;

  await tgApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });

  // Пользовательские действия
  if (data === "main_menu") {
    await showUserMainMenu(chatId, messageId, env);
    return;
  }

  if (data === "support_info") {
    await showSupportInfo(chatId, messageId, env);
    return;
  }

  if (data.startsWith("view_tariff:")) {
    const tariffId = Number(data.split(":")[1]);
    await showTariffDetails(chatId, messageId, tariffId, env);
    return;
  }

  if (data.startsWith("pay_yk:")) {
    const tariffId = Number(data.split(":")[1]);
    await initiateYooKassaPayment(chatId, messageId, userId, tariffId, env);
    return;
  }

  if (data.startsWith("check_yk:")) {
    const paymentId = data.split(":")[1];
    await checkYooKassaPaymentManual(chatId, messageId, paymentId, env);
    return;
  }

  if (data.startsWith("pay_trb:")) {
    const tariffId = Number(data.split(":")[1]);
    await showTributePaymentScreen(chatId, messageId, tariffId, env);
    return;
  }

  // Действия администратора
  if (!isAdmin(userId, env)) return;

  if (data === "admin_menu") {
    await clearAdminState(env, userId);
    await showAdminMenu(chatId, messageId, env);
    return;
  }

  if (data.startsWith("adm_set_ch:")) {
    const chId = data.split(":")[1];
    await setSetting(env, "channel_id", chId);
    await showAdminMenu(chatId, messageId, env, `Основной канал успешно установлен: ${chId}`);
    return;
  }

  if (data.startsWith("adm_edit:")) {
    const key = data.split(":")[1];
    await promptSettingEdit(chatId, messageId, userId, key, env);
    return;
  }

  if (data === "adm_support") {
    await showAdminSupportMenu(chatId, messageId, env);
    return;
  }

  if (data === "adm_channel") {
    await promptChannelEdit(chatId, messageId, userId, env);
    return;
  }

  if (data === "adm_test_link") {
    await testChannelLinkGeneration(chatId, messageId, userId, env);
    return;
  }

  if (data === "adm_tariffs") {
    await clearAdminState(env, userId);
    await showAdminTariffs(chatId, messageId, env);
    return;
  }

  if (data === "adm_t_add") {
    await setAdminState(env, userId, "add_tariff:name", {});
    await sendOrEdit(
      env,
      chatId,
      messageId,
      "<b>Создание нового тарифа (Шаг 1 из 4)</b>\n\nВведите название тарифа (например: «Доступ на 1 месяц»):",
      [[{ text: "Отмена", callback_data: "adm_tariffs" }]]
    );
    return;
  }

  if (data.startsWith("adm_t_view:")) {
    const tariffId = Number(data.split(":")[1]);
    await clearAdminState(env, userId);
    await showAdminTariffDetail(chatId, messageId, tariffId, env);
    return;
  }

  if (data.startsWith("adm_t_edit:")) {
    const parts = data.split(":");
    const tariffId = Number(parts[1]);
    const field = parts[2];
    await promptTariffFieldEdit(chatId, messageId, userId, tariffId, field, env);
    return;
  }

  if (data.startsWith("adm_t_del:")) {
    const tariffId = Number(data.split(":")[1]);
    await env.DB.prepare("DELETE FROM tariffs WHERE id = ?").bind(tariffId).run();
    await showAdminTariffs(chatId, messageId, env);
    return;
  }
}

/* ============================================================================
   ОПЛАТА: ЮKASSA И TRIBUTE
============================================================================ */

async function initiateYooKassaPayment(chatId, messageId, userId, tariffId, env) {
  const tariff = await env.DB.prepare("SELECT * FROM tariffs WHERE id = ?").bind(tariffId).first();
  if (!tariff) return;

  const idempotenceKey = crypto.randomUUID();
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);

  const payload = {
    amount: {
      value: Number(tariff.price).toFixed(2),
      currency: "RUB"
    },
    capture: true,
    confirmation: {
      type: "redirect",
      return_url: env.BOT_RETURN_URL || "https://t.me"
    },
    description: `Тариф: ${tariff.name} (Пользователь ID ${userId})`,
    metadata: {
      user_id: String(userId),
      tariff_id: String(tariff.id)
    }
  };

  const response = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Idempotence-Key": idempotenceKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("YooKassa error:", errText);
    await sendOrEdit(env, chatId, messageId, "Не удалось сформировать счет в ЮKassa. Попробуйте позже или обратитесь в поддержку.", [
      [{ text: "Назад", callback_data: `view_tariff:${tariffId}` }]
    ]);
    return;
  }

  const paymentData = await response.json();
  const paymentId = paymentData.id;
  const confirmationUrl = paymentData.confirmation.confirmation_url;

  await env.DB.prepare(
    "INSERT INTO payments (id, user_id, tariff_id, provider, amount, status) VALUES (?, ?, ?, 'yookassa', ?, 'pending')"
  )
    .bind(paymentId, userId, tariff.id, tariff.price)
    .run();

  const text =
    `<b>Счет на оплату сформирован</b>\n\n` +
    `Тариф: <b>${escapeHtml(tariff.name)}</b>\n` +
    `Сумма к оплате: <b>${tariff.price} руб.</b>\n\n` +
    `Перейдите по кнопке ниже для оплаты. После завершения платежа бот автоматически пришлет ссылку, либо вы можете нажать кнопку «Проверить оплату».`;

  const keyboard = [
    [{ text: "Перейти к оплате (ЮKassa)", url: confirmationUrl }],
    [{ text: "Проверить оплату", callback_data: `check_yk:${paymentId}` }],
    [{ text: "Назад", callback_data: `view_tariff:${tariffId}` }]
  ];

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function checkYooKassaPaymentManual(chatId, messageId, paymentId, env) {
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { "Authorization": `Basic ${auth}` }
  });

  if (!res.ok) return;
  const payment = await res.json();

  if (payment.status === "succeeded") {
    const userId = Number(payment.metadata?.user_id || chatId);
    const tariffId = Number(payment.metadata?.tariff_id || 0);
    await fulfillOrder(payment.id, userId, tariffId, "yookassa", Number(payment.amount.value), env);
  } else {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "Оплата еще не поступила. Если вы уже оплатили счет, подождите 10–15 секунд и нажмите «Проверить оплату» повторно."
    });
  }
}

async function handleYooKassaWebhook(body, env) {
  if (body.event !== "payment.succeeded" || !body.object?.id) return;

  const paymentId = body.object.id;
  const auth = btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { "Authorization": `Basic ${auth}` }
  });

  if (!res.ok) return;
  const payment = await res.json();

  if (payment.status === "succeeded") {
    const userId = Number(payment.metadata?.user_id);
    const tariffId = Number(payment.metadata?.tariff_id);
    if (userId && tariffId) {
      await fulfillOrder(payment.id, userId, tariffId, "yookassa", Number(payment.amount.value), env);
    }
  }
}

async function showTributePaymentScreen(chatId, messageId, tariffId, env) {
  const tariff = await env.DB.prepare("SELECT * FROM tariffs WHERE id = ?").bind(tariffId).first();
  if (!tariff || !tariff.tribute_url) return;

  const text =
    `<b>Оплата через Tribute</b>\n\n` +
    `Тариф: <b>${escapeHtml(tariff.name)}</b>\n` +
    `Стоимость: <b>${tariff.price} руб.</b>\n\n` +
    `Нажмите на кнопку ниже для перехода на страницу оплаты в Tribute. Сразу после подтверждения транзакции бот автоматически сформирует и пришлет вам в этот чат одноразовую ссылку для входа в канал.`;

  const keyboard = [
    [{ text: "Перейти к оплате в Tribute", url: tariff.tribute_url }],
    [{ text: "Назад", callback_data: `view_tariff:${tariffId}` }]
  ];

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function handleTributeWebhook(body, env) {
  const allowedEvents = ["new_subscription", "new_digital_product", "shop_order", "new_donation"];
  if (!allowedEvents.includes(body.name) || !body.payload) return;

  const telegramUserId = body.payload.telegram_user_id;
  if (!telegramUserId) return;

  const paymentKey = `trb_${body.name}_${body.sent_at || body.created_at}_${telegramUserId}`;
  const amount = Number(body.payload.amount || body.payload.price || 0);

  const firstTariff = await env.DB.prepare("SELECT id FROM tariffs WHERE is_active = 1 LIMIT 1").first();
  const tariffId = firstTariff ? firstTariff.id : 0;

  await fulfillOrder(paymentKey, Number(telegramUserId), tariffId, "tribute", amount, env);
}

/* ============================================================================
   ВЫДАЧА ОДНОРАЗОВОЙ ССЫЛКИ В КАНАЛ
============================================================================ */

async function fulfillOrder(paymentId, userId, tariffId, provider, amount, env) {
  const existing = await env.DB.prepare("SELECT status, invite_link FROM payments WHERE id = ?")
    .bind(paymentId)
    .first();

  if (existing && existing.status === "succeeded" && existing.invite_link) {
    return;
  }

  const settings = await getSettings(env);
  let targetChannelId = settings.channel_id;

  if (tariffId) {
    const tariff = await env.DB.prepare("SELECT channel_id, name FROM tariffs WHERE id = ?")
      .bind(tariffId)
      .first();
    if (tariff && tariff.channel_id) {
      targetChannelId = tariff.channel_id;
    }
  }

  if (!targetChannelId) {
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: "Оплата получена, однако канал для выдачи ссылки еще не настроен администратором. Пожалуйста, обратитесь в поддержку."
    });
    return;
  }

  const inviteRes = await tgApi(env.BOT_TOKEN, "createChatInviteLink", {
    chat_id: targetChannelId,
    name: `User ${userId} (${provider})`,
    member_limit: 1,
    creates_join_request: false
  });

  if (!inviteRes.ok || !inviteRes.result?.invite_link) {
    console.error("Failed to create invite link:", inviteRes);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: "Оплата прошла успешно, но возникла техническая ошибка при генерации ссылки. Пожалуйста, напишите в поддержку."
    });
    return;
  }

  const inviteLink = inviteRes.result.invite_link;

  await env.DB.prepare(
    `INSERT INTO payments (id, user_id, tariff_id, provider, amount, status, invite_link)
     VALUES (?, ?, ?, ?, ?, 'succeeded', ?)
     ON CONFLICT(id) DO UPDATE SET status = 'succeeded', invite_link = excluded.invite_link`
  )
    .bind(paymentId, userId, tariffId, provider, amount, inviteLink)
    .run();

  const text =
    `<b>Оплата подтверждена</b>\n\n` +
    `${escapeHtml(settings.success_text)}\n\n` +
    `Ваша одноразовая ссылка для входа:\n${inviteLink}`;

  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: userId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Войти в закрытый канал", url: inviteLink }]
      ]
    }
  });
}

/* ============================================================================
   АДМИН-ПАНЕЛЬ: УПРАВЛЕНИЕ ТЕКСТАМИ, ТАРИФАМИ, КАНАЛОМ И ПОДДЕРЖКОЙ
============================================================================ */

async function showAdminMenu(chatId, messageId, env, notice = "") {
  const settings = await getSettings(env);
  const { results: tariffs } = await env.DB.prepare("SELECT id FROM tariffs").all();

  let text = "";
  if (notice) {
    text += `<b>Уведомление:</b> ${escapeHtml(notice)}\n\n`;
  }

  text +=
    `<b>Панель администратора</b>\n\n` +
    `<b>Название (заголовок):</b> ${escapeHtml(settings.bot_title)}\n` +
    `<b>Описание:</b> ${escapeHtml(settings.bot_description)}\n` +
    `<b>Основной канал (ID):</b> <code>${escapeHtml(settings.channel_id || "Не задан")}</code>\n` +
    `<b>Контакт поддержки:</b> ${escapeHtml(settings.support_contact)}\n` +
    `<b>Количество тарифов:</b> ${tariffs.length}\n\n` +
    `Выберите раздел для редактирования:`;

  const keyboard = [
    [{ text: "Управление тарифами и ценами", callback_data: "adm_tariffs" }],
    [{ text: "Изменить название (заголовок)", callback_data: "adm_edit:bot_title" }],
    [{ text: "Изменить описание бота", callback_data: "adm_edit:bot_description" }],
    [{ text: "Изменить текст после оплаты", callback_data: "adm_edit:success_text" }],
    [{ text: "Настроить раздел «Поддержка»", callback_data: "adm_support" }],
    [{ text: "Привязать / изменить канал", callback_data: "adm_channel" }],
    [{ text: "Проверить создание одноразовой ссылки", callback_data: "adm_test_link" }],
    [{ text: "Перейти в меню пользователя", callback_data: "main_menu" }]
  ];

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function showAdminSupportMenu(chatId, messageId, env) {
  const settings = await getSettings(env);
  const text =
    `<b>Настройка раздела поддержки</b>\n\n` +
    `<b>Текущий текст:</b>\n${escapeHtml(settings.support_text)}\n\n` +
    `<b>Текущий контакт (юзернейм или ссылка):</b>\n${escapeHtml(settings.support_contact)}`;

  const keyboard = [
    [{ text: "Изменить текст поддержки", callback_data: "adm_edit:support_text" }],
    [{ text: "Изменить контакт (@username / ссылка)", callback_data: "adm_edit:support_contact" }],
    [{ text: "Назад в админ-панель", callback_data: "admin_menu" }]
  ];

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function promptSettingEdit(chatId, messageId, userId, key, env) {
  const labels = {
    bot_title: "Введите новое название (заголовок) главного меню:",
    bot_description: "Введите новое описание для главного меню:",
    success_text: "Введите текст, который бот будет присылать пользователю после успешной оплаты вместе со ссылкой:",
    support_text: "Введите пояснительный текст для раздела «По вопросам и поддержке»:",
    support_contact: "Введите юзернейм поддержки (например, @username) или прямую ссылку (https://t.me/...):"
  };

  await setAdminState(env, userId, `edit_setting:${key}`, {});
  await sendOrEdit(
    env,
    chatId,
    messageId,
    `<b>Редактирование настройки</b>\n\n${labels[key] || "Введите новое значение:"}`,
    [[{ text: "Отмена", callback_data: "admin_menu" }]]
  );
}

async function promptChannelEdit(chatId, messageId, userId, env) {
  const settings = await getSettings(env);
  await setAdminState(env, userId, "edit_channel", {});

  const text =
    `<b>Привязка закрытого канала</b>\n\n` +
    `Текущий ID канала: <code>${escapeHtml(settings.channel_id || "Не задан")}</code>\n\n` +
    `Чтобы бот мог создавать одноразовые ссылки:\n` +
    `1. Добавьте бота в ваш закрытый канал в качестве администратора с правом «Добавление подписчиков» (управление ссылками-приглашениями).\n` +
    `2. Перешлите сюда любое сообщение из этого канала ИЛИ отправьте его ID (начинается с <code>-100...</code>).`;

  await sendOrEdit(env, chatId, messageId, text, [
    [{ text: "Отмена", callback_data: "admin_menu" }]
  ]);
}

async function testChannelLinkGeneration(chatId, messageId, userId, env) {
  const settings = await getSettings(env);
  if (!settings.channel_id) {
    await showAdminMenu(chatId, messageId, env, "Сначала укажите ID канала в настройках.");
    return;
  }

  const res = await tgApi(env.BOT_TOKEN, "createChatInviteLink", {
    chat_id: settings.channel_id,
    name: "Тестовая одноразовая ссылка",
    member_limit: 1
  });

  if (res.ok && res.result?.invite_link) {
    await sendOrEdit(
      env,
      chatId,
      messageId,
      `<b>Проверка прошла успешно</b>\n\nБот имеет необходимые права в канале <code>${settings.channel_id}</code>.\nСгенерирована тестовая одноразовая ссылка (на 1 вход):\n${res.result.invite_link}`,
      [[{ text: "Назад в админ-панель", callback_data: "admin_menu" }]]
    );
  } else {
    await sendOrEdit(
      env,
      chatId,
      messageId,
      `<b>Ошибка создания ссылки</b>\n\nОтвет Telegram: <code>${escapeHtml(res.description || "Неизвестная ошибка")}</code>\n\nУбедитесь, что бот добавлен в канал <code>${escapeHtml(settings.channel_id)}</code> как администратор и у него включено право «Добавление подписчиков».`,
      [[{ text: "Назад в админ-панель", callback_data: "admin_menu" }]]
    );
  }
}

async function showAdminTariffs(chatId, messageId, env) {
  const { results: tariffs } = await env.DB.prepare("SELECT * FROM tariffs ORDER BY id ASC").all();

  const keyboard = [];
  for (const t of tariffs) {
    keyboard.push([
      { text: `${t.name} (${t.price} руб.)`, callback_data: `adm_t_view:${t.id}` }
    ]);
  }

  keyboard.push([{ text: "+ Добавить новый тариф", callback_data: "adm_t_add" }]);
  keyboard.push([{ text: "Назад в админ-панель", callback_data: "admin_menu" }]);

  const text =
    `<b>Управление тарифами</b>\n\n` +
    `Выберите тариф для изменения цены, названия, описания или ссылки Tribute, либо создайте новый тариф.`;

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function showAdminTariffDetail(chatId, messageId, tariffId, env) {
  const t = await env.DB.prepare("SELECT * FROM tariffs WHERE id = ?").bind(tariffId).first();
  if (!t) {
    await showAdminTariffs(chatId, messageId, env);
    return;
  }

  const text =
    `<b>Тариф #${t.id}</b>\n\n` +
    `<b>Название:</b> ${escapeHtml(t.name)}\n` +
    `<b>Описание:</b> ${escapeHtml(t.description)}\n` +
    `<b>Цена:</b> ${t.price} руб.\n` +
    `<b>Ссылка Tribute:</b> ${escapeHtml(t.tribute_url || "Не указана")}\n` +
    `<b>ID канала тарифа:</b> <code>${escapeHtml(t.channel_id || "Используется основной канал")}</code>`;

  const keyboard = [
    [{ text: "Изменить название", callback_data: `adm_t_edit:${t.id}:name` }],
    [{ text: "Изменить описание", callback_data: `adm_t_edit:${t.id}:description` }],
    [{ text: "Изменить цену (руб.)", callback_data: `adm_t_edit:${t.id}:price` }],
    [{ text: "Изменить ссылку Tribute", callback_data: `adm_t_edit:${t.id}:tribute_url` }],
    [{ text: "Задать отдельный ID канала", callback_data: `adm_t_edit:${t.id}:channel_id` }],
    [{ text: "Удалить тариф", callback_data: `adm_t_del:${t.id}` }],
    [{ text: "Назад к списку тарифов", callback_data: "adm_tariffs" }]
  ];

  await sendOrEdit(env, chatId, messageId, text, keyboard);
}

async function promptTariffFieldEdit(chatId, messageId, userId, tariffId, field, env) {
  const prompts = {
    name: "Введите новое название тарифа:",
    description: "Введите новое описание тарифа:",
    price: "Введите новую стоимость тарифа в рублях (только целое число, например: 1500):",
    tribute_url: "Введите ссылку на оплату этого тарифа в Tribute (или отправьте «-», чтобы отключить оплату через Tribute для этого тарифа):",
    channel_id: "Введите ID канала для этого тарифа (или отправьте «-», чтобы использовался основной канал бота):"
  };

  await setAdminState(env, userId, `edit_tariff:${tariffId}:${field}`, {});
  await sendOrEdit(
    env,
    chatId,
    messageId,
    `<b>Редактирование тарифа</b>\n\n${prompts[field]}`,
    [[{ text: "Отмена", callback_data: `adm_t_view:${tariffId}` }]]
  );
}

async function processAdminInput(msg, state, tempData, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  // 1. Привязка канала (текстом или пересланным сообщением из канала)
  if (state === "edit_channel") {
    let channelId = text;
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      channelId = String(msg.forward_from_chat.id);
    } else if (msg.forward_origin && msg.forward_origin.chat?.type === "channel") {
      channelId = String(msg.forward_origin.chat.id);
    }

    await setSetting(env, "channel_id", channelId);
    await clearAdminState(env, userId);
    await showAdminMenu(chatId, null, env, `ID основного канала сохранен: ${channelId}`);
    return;
  }

  // 2. Изменение глобальной настройки
  if (state.startsWith("edit_setting:")) {
    const key = state.split(":")[1];
    await setSetting(env, key, text);
    await clearAdminState(env, userId);
    await showAdminMenu(chatId, null, env, "Настройка успешно обновлена.");
    return;
  }

  // 3. Пошаговое добавление нового тарифа
  if (state === "add_tariff:name") {
    tempData.name = text;
    await setAdminState(env, userId, "add_tariff:description", tempData);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "<b>Создание нового тарифа (Шаг 2 из 4)</b>\n\nВведите описание тарифа:",
      parse_mode: "HTML"
    });
    return;
  }

  if (state === "add_tariff:description") {
    tempData.description = text;
    await setAdminState(env, userId, "add_tariff:price", tempData);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "<b>Создание нового тарифа (Шаг 3 из 4)</b>\n\nВведите стоимость тарифа в рублях (числом, например 1500):",
      parse_mode: "HTML"
    });
    return;
  }

  if (state === "add_tariff:price") {
    const price = parseInt(text, 10);
    if (isNaN(price) || price <= 0) {
      await tgApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "Пожалуйста, введите корректное положительное число."
      });
      return;
    }
    tempData.price = price;
    await setAdminState(env, userId, "add_tariff:tribute_url", tempData);
    await tgApi(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "<b>Создание нового тарифа (Шаг 4 из 4)</b>\n\nОтправьте ссылку на оплату этого тарифа в Tribute (например, <code>https://t.me/tribute/app?startapp=...</code>) или отправьте «-», если оплата через Tribute не требуется:",
      parse_mode: "HTML"
    });
    return;
  }

  if (state === "add_tariff:tribute_url") {
    const tributeUrl = text === "-" ? "" : text;
    await env.DB.prepare(
      "INSERT INTO tariffs (name, description, price, tribute_url) VALUES (?, ?, ?, ?)"
    )
      .bind(tempData.name, tempData.description, tempData.price, tributeUrl)
      .run();

    await clearAdminState(env, userId);
    await showAdminTariffs(chatId, null, env);
    return;
  }

  // 4. Редактирование отдельного поля существующего тарифа
  if (state.startsWith("edit_tariff:")) {
    const parts = state.split(":");
    const tariffId = Number(parts[1]);
    const field = parts[2];

    const allowedFields = ["name", "description", "price", "tribute_url", "channel_id"];
    if (!allowedFields.includes(field)) return;

    let value = text;
    if (field === "price") {
      const parsed = parseInt(text, 10);
      if (isNaN(parsed) || parsed <= 0) {
        await tgApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "Введите корректное положительное число."
        });
        return;
      }
      value = parsed;
    } else if ((field === "tribute_url" || field === "channel_id") && text === "-") {
      value = "";
    }

    await env.DB.prepare(`UPDATE tariffs SET ${field} = ? WHERE id = ?`)
      .bind(value, tariffId)
      .run();

    await clearAdminState(env, userId);
    await showAdminTariffDetail(chatId, null, tariffId, env);
  }
}

/* ============================================================================
   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
============================================================================ */

async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const map = {};
  for (const r of results) {
    map[r.key] = r.value;
  }
  return map;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(key, String(value))
    .run();
}

async function setAdminState(env, userId, state, tempData) {
  await env.DB.prepare(
    "INSERT INTO admin_states (user_id, state, temp_data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, temp_data = excluded.temp_data"
  )
    .bind(userId, state, JSON.stringify(tempData))
    .run();
}

async function clearAdminState(env, userId) {
  await env.DB.prepare("DELETE FROM admin_states WHERE user_id = ?").bind(userId).run();
}

function isAdmin(userId, env) {
  if (!userId || !env.ADMIN_IDS) return false;
  const ids = String(env.ADMIN_IDS)
    .split(",")
    .map(s => Number(s.trim()));
  return ids.includes(Number(userId));
}

function formatContactUrl(contact) {
  if (!contact) return "";
  const trimmed = contact.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    return `https://t.me/${trimmed.slice(1)}`;
  }
  return `https://t.me/${trimmed}`;
}

async function verifyTributeSignature(rawBody, signature, secretKey) {
  if (!signature || !secretKey || secretKey === "0") return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const hashArray = Array.from(new Uint8Array(sigBuffer));
  const computedHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex.toLowerCase() === signature.trim().toLowerCase();
}

async function sendOrEdit(env, chatId, messageId, text, inlineKeyboard) {
  const reply_markup = inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined;
  if (messageId) {
    const res = await tgApi(env.BOT_TOKEN, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup
    });
    if (res.ok) return;
  }
  await tgApi(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup
  });
}

async function tgApi(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}
