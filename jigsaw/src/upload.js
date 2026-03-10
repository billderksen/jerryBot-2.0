import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { mkdirSync } from 'fs';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
mkdirSync(UPLOADS_DIR, { recursive: true });

const router = Router();

const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, and WebP images are allowed'));
    }
  }
});

// POST /api/upload — upload a puzzle image
router.post('/api/upload', (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 10MB)' });
      }
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    try {
      const ext = extname(req.file.originalname).toLowerCase() || '.jpg';
      const filename = `${uuidv4()}${ext}`;
      const outputPath = join(UPLOADS_DIR, filename);

      // Resize if larger than 2000px on longest side
      await sharp(req.file.buffer)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .toFile(outputPath);

      // Derive display name from original filename (without extension)
      const displayName = req.file.originalname.replace(/\.[^.]+$/, '') || 'Uploaded Image';
      const uploadedBy = req.user?.id ?? null;

      const result = db.prepare(
        'INSERT INTO puzzle_images (filename, display_name, is_builtin, uploaded_by) VALUES (?, ?, 0, ?)'
      ).run(filename, displayName, uploadedBy);

      res.status(201).json({
        imageId: result.lastInsertRowid,
        filename
      });
    } catch (error) {
      console.error('Upload processing error:', error);
      res.status(500).json({ error: 'Failed to process image' });
    }
  });
});

export default router;
