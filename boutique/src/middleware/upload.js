'use strict';

/** Téléversements : validation du type réel, de la taille et du nombre. */

const multer = require('multer');
const config = require('../config');
const images = require('../lib/images');

const storage = multer.memoryStorage();

/** Images produit / logo. Le type est vérifié sur les octets, pas sur l'extension. */
const imageUpload = multer({
  storage,
  limits: {
    fileSize: config.storage.maxUploadBytes,
    files: 12,
    // Le formulaire produit est envoyé en multipart (photos incluses) : il porte
    // aussi toutes les lignes de variantes, caractéristiques et composants de
    // kit. Une limite trop basse couperait un formulaire légitime.
    fields: 2000,
    fieldSize: 1024 * 64,
    parts: 3000,
  },
  fileFilter(req, file, cb) {
    const declared = String(file.mimetype || '');
    if (!config.storage.allowedImageTypes.includes(declared)) {
      return cb(
        Object.assign(new Error(`Format « ${declared || 'inconnu'} » non accepté. Formats autorisés : ${config.storage.allowedImageTypes.join(', ')}.`), {
          status: 415,
        })
      );
    }
    cb(null, true);
  },
}).array('images', 12);

const singleImage = multer({
  storage,
  limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
}).single('image');

/** Fichiers d'import catalogue. */
const importUpload = multer({
  storage,
  limits: { fileSize: require('../domain/imports').MAX_FILE_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || '').toLowerCase();
    if (!/\.(xlsx|xlsm|csv)$/.test(name)) {
      return cb(Object.assign(new Error('Format non pris en charge : utilisez un fichier .xlsx ou .csv.'), { status: 415 }));
    }
    cb(null, true);
  },
}).single('fichier');

/** Gère les erreurs Multer en réponses lisibles. */
function wrap(handler) {
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          Object.assign(
            new Error(`Fichier trop volumineux. Limite : ${Math.round(config.storage.maxUploadBytes / 1024 / 1024)} Mo par image.`),
            { status: 413 }
          )
        );
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(Object.assign(new Error('Trop de fichiers ou champ inattendu.'), { status: 400 }));
      }
      return next(err);
    });
  };
}

module.exports = { imageUpload: wrap(imageUpload), singleImage: wrap(singleImage), importUpload: wrap(importUpload), images };
