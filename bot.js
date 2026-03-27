const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = '7859846038:AAGiRMU7UOF82tCjBWRH-xMZCz2XZo358Tc';
const WEBAPP_URL = 'https://canedius.github.io/png-order-webapp/';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  if (error.message && error.message.includes('409')) {
    console.log('409 conflict — зупиняю polling на 30с...');
    bot.stopPolling();
    setTimeout(() => bot.startPolling(), 30000);
  } else {
    console.error('polling_error:', error.message);
  }
});

// /start — показує кнопку WebApp
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Натисніть кнопку нижче, щоб створити замовлення:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '📝 Нове замовлення', web_app: { url: WEBAPP_URL } }
      ]]
    }
  });
});

// /order — теж відкриває форму
bot.onText(/\/order/, (msg) => {
  bot.sendMessage(msg.chat.id, '📝 Створити замовлення на друк:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '📝 Відкрити форму', web_app: { url: WEBAPP_URL } }
      ]]
    }
  });
});

// Отримуємо дані з WebApp (web_app_data)
bot.on('web_app_data', async (msg) => {
  try {
    const data = JSON.parse(msg.web_app_data.data);
    const user = msg.from.first_name || 'Невідомий';

    // Формуємо красиве повідомлення
    let text = `📦 <b>Нове замовлення від ${user}</b>\n\n`;

    data.items.forEach((item, i) => {
      text += `<b>Позиція ${i + 1}:</b>\n`;
      text += `  Тип: ${item.type}\n`;
      text += `  Колір: ${item.color}\n`;
      text += `  Розмір: ${item.size}\n`;
      text += `  Кількість: ${item.qty}\n`;
      if (item.customization) {
        text += `  Кастомізація: ${item.customization}\n`;
      }
      text += '\n';
    });

    text += `<b>Доставка:</b>\n`;
    text += `  ${data.delivery.name}\n`;
    text += `  ${data.delivery.phone}\n`;
    text += `  ${data.delivery.address}\n`;

    if (data.comment) {
      text += `\n<b>Коментар:</b> ${data.comment}`;
    }

    // Постимо в чат
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Error processing web_app_data:', err);
  }
});

console.log('PNG Order Bot started...');
