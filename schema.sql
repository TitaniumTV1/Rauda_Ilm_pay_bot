CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tariffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price INTEGER NOT NULL,
    tribute_url TEXT DEFAULT '',
    channel_id TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS admin_states (
    user_id INTEGER PRIMARY KEY,
    state TEXT NOT NULL,
    temp_data TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    tariff_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    invite_link TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (key, value) VALUES
('bot_title', 'Закрытый информационный канал'),
('bot_description', 'Добро пожаловать. Здесь вы можете оформить доступ к закрытому каналу. Выберите подходящий тариф ниже.'),
('success_text', 'Оплата успешно подтверждена. Ниже находится ваша персональная одноразовая ссылка для входа в канал. Внимание: ссылка действует только для одного перехода.'),
('support_text', 'Если у вас возникли вопросы по оплате или доступу к каналу, свяжитесь с поддержкой по контакту ниже.'),
('support_contact', '@support_username'),
('channel_id', '');
