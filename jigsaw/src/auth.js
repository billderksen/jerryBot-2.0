import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcrypt';
import db from './db.js';

const SALT_ROUNDS = 10;

export function setupAuth(app) {
  app.use(passport.initialize());
  app.use(passport.session());

  // Serialize / deserialize
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    const user = db.prepare('SELECT id, username, discord_id, avatar_url FROM users WHERE id = ?').get(id);
    done(null, user || null);
  });

  // --- Local Strategy ---
  passport.use(new LocalStrategy((username, password, done) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return done(null, false, { message: 'Invalid username or password' });
    if (!user.password_hash) return done(null, false, { message: 'Account uses Discord login' });

    bcrypt.compare(password, user.password_hash).then(match => {
      if (!match) return done(null, false, { message: 'Invalid username or password' });
      done(null, { id: user.id, username: user.username });
    }).catch(err => done(err));
  }));

  // --- Local auth routes ---
  app.post('/auth/register', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || typeof username !== 'string' || username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
      }
      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        return res.status(409).json({ error: 'Username already taken' });
      }

      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
      const userId = result.lastInsertRowid;

      db.prepare('INSERT INTO stats (user_id) VALUES (?)').run(userId);

      const user = { id: userId, username };
      req.login(user, (err) => {
        if (err) return res.status(500).json({ error: 'Login failed after registration' });
        res.json({ user: { id: user.id, username: user.username } });
      });
    } catch (err) {
      console.error('Registration error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/auth/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: info?.message || 'Authentication failed' });
      req.login(user, (err) => {
        if (err) return next(err);
        res.json({ user: { id: user.id, username: user.username } });
      });
    })(req, res, next);
  });

  app.post('/auth/logout', (req, res) => {
    req.logout((err) => {
      if (err) return res.status(500).json({ error: 'Logout failed' });
      res.json({ ok: true });
    });
  });

  app.get('/auth/me', (req, res) => {
    if (req.isAuthenticated()) {
      const { id, username, discord_id, avatar_url } = req.user;
      return res.json({ user: { id, username, discord_id, avatar_url } });
    }
    res.json({ user: null });
  });

  // --- Discord OAuth2 (optional) ---
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    import('passport-discord').then(({ default: DiscordStrategy }) => {
      passport.use(new DiscordStrategy({
        clientID: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackURL: process.env.DISCORD_CALLBACK_URL || '/auth/discord/callback',
        scope: ['identify']
      }, (accessToken, refreshToken, profile, done) => {
        try {
          let user = db.prepare('SELECT id, username, discord_id, avatar_url FROM users WHERE discord_id = ?').get(profile.id);

          if (!user) {
            const avatarUrl = profile.avatar
              ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
              : null;
            const username = profile.username;

            const result = db.prepare(
              'INSERT INTO users (username, discord_id, avatar_url) VALUES (?, ?, ?)'
            ).run(username, profile.id, avatarUrl);

            const userId = result.lastInsertRowid;
            db.prepare('INSERT INTO stats (user_id) VALUES (?)').run(userId);

            user = { id: userId, username, discord_id: profile.id, avatar_url: avatarUrl };
          }

          done(null, user);
        } catch (err) {
          done(err);
        }
      }));

      app.get('/auth/discord', passport.authenticate('discord'));

      app.get('/auth/discord/callback',
        passport.authenticate('discord', { failureRedirect: '/' }),
        (req, res) => res.redirect('/')
      );

      console.log('Discord OAuth2 authentication enabled');
    }).catch(err => {
      console.warn('Failed to load passport-discord:', err.message);
    });
  }
}
