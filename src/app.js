const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { currentUser } = require('./middleware/auth');
const csrf = require('./middleware/csrf');
const locals = require('./middleware/locals');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.set('query parser', 'extended');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Mini sites and cost sheets are shared as links; referrer stays minimal.
    referrerPolicy: { policy: 'same-origin' },
  }));

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.env === 'production' ? '7d' : 0 }));

  const sessionStore = MongoStore.create({
    mongoUrl: config.mongoUri,
    collectionName: 'sessions',
    ttl: config.sessionMaxAgeMs / 1000,
  });
  app.locals.sessionStore = sessionStore;

  app.use(session({
    name: 'crm.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production',
      maxAge: config.sessionMaxAgeMs,
    },
  }));

  // Spec §74: rate limiting. Auth and public capture endpoints are the ones
  // worth protecting; ordinary authenticated app traffic is left alone.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const publicLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
  app.locals.limiters = { auth: authLimiter, public: publicLimiter };

  app.use(currentUser);
  app.use(locals);

  // Public routes authenticate by integration key or signed token and carry no
  // session, so they are mounted ahead of the CSRF gate (§63, §25.3).
  app.use('/', require('./routes/public'));

  app.use(csrf);
  app.use('/', require('./routes/auth'));
  app.use('/', require('./routes/dashboard'));
  app.use('/', require('./routes/leads'));
  app.use('/', require('./routes/followups'));
  app.use('/', require('./routes/visits'));
  app.use('/', require('./routes/projects'));
  app.use('/', require('./routes/deals'));
  app.use('/', require('./routes/bookings'));
  app.use('/', require('./routes/channel-partners'));
  /**
   * V2 §24: the partner portal is a separate identity layer. It is mounted
   * after the internal routers and never shares their auth middleware.
   */
  app.use('/', require('./routes/cp-portal'));
  app.use('/', require('./routes/files'));
  app.use('/', require('./routes/contacts'));
  app.use('/', require('./routes/campaigns'));
  app.use('/', require('./routes/reports'));
  app.use('/', require('./routes/setup-communication'));
  app.use('/', require('./routes/setup'));

  app.get('/', (req, res) => res.redirect(req.user ? '/app/dashboard' : '/login'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
