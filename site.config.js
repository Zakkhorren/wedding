/**
 * Меняйте тексты и фотографии здесь — верстку трогать не нужно.
 * Для окончательной версии положите собственные изображения в assets/ и укажите путь вида assets/photo.jpg.
 * Production-пакет и порядок запуска описаны в PRODUCTION-ROLLOUT.md.
 * НИКОГДА не вписывайте сюда токен Telegram-бота, пароль, секретный API key или chat_id.
 */
window.WEDDING_CONFIG = {
  names: { first: 'Соня', second: 'Леша' },
  date: '2027-01-23',
  dateTime: '16:00',
  rsvpDeadline: '2026-12-20',
  heroImage: 'assets/couple.png',
  venueImage: 'assets/venue.jpg',
  venueName: 'Поселок Новобутаково',
  venueAddress: 'поселок Новобутаково 44с1',
  venueMapUrl: 'https://yandex.ru/maps/?mode=search&text=%D0%BF%D0%BE%D1%81%D0%B5%D0%BB%D0%BE%D0%BA%20%D0%9D%D0%BE%D0%B2%D0%BE%D0%B1%D1%83%D1%82%D0%B0%D0%BA%D0%BE%D0%B2%D0%BE%2044%D1%811',
  schedule: [
    ['16:00', 'сбор гостей'],
    ['17:00', 'торжественная церемония'],
    ['18:00', 'банкет и танцы'],
    ['22:00', 'обнимашки на прощание']
  ],
  // Production package: deploy only AFTER the production API v2 is ready.
  // Only the public Turnstile Site key belongs here, never its Secret key.
  // Set rsvpMode to 'maintenance' to pause submissions without demo success.
  rsvpMode: 'production',
  rsvpEndpoint: 'https://wedding-rsvp-api.zakk-horren.workers.dev/rsvp',
  turnstileSitekey: '', // REQUIRED before launch: wedding-rsvp-form public Site key.
  // The isolated preview launcher explicitly selects demo + preview mode.
  rsvpPreview: {
    enabled: false,
    endpoint: 'https://wedding-rsvp-api-test.zakk-horren.workers.dev/rsvp',
    turnstileSitekey: ''
  }
};
