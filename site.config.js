/**
 * Меняйте тексты и фотографии здесь — верстку трогать не нужно.
 * Для окончательной версии положите собственные изображения в assets/ и укажите путь вида assets/photo.jpg.
 * Для приема ответов укажите публичный HTTPS URL вашего ЗАЩИЩЕННОГО обработчика (Cloudflare Worker, Formspree и т.п.).
 * НИКОГДА не вписывайте сюда токен Telegram-бота, пароль, API key или chat_id.
 */
window.WEDDING_CONFIG = {
  names: { first: 'Соня', second: 'Леша' },
  date: '2027-01-23',
  dateTime: '16:00',
  rsvpDeadline: '2026-12-20',
  heroImages: [
    'assets/sonya.png',
    'assets/lesha.png'
  ],
  venueImage: 'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1100&q=85',
  venueName: 'Поселок Новобутаково',
  venueAddress: 'поселок Новобутаково 44с1',
  venueMapUrl: 'https://yandex.ru/maps/',
  schedule: [
    ['16:00', 'сбор гостей'],
    ['17:00', 'торжественная церемония'],
    ['18:00', 'банкет и танцы'],
    ['22:00', 'обнимашки на прощание']
  ],
  rsvpEndpoint: ''
};
