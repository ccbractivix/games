'use strict';

const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GameError } = require('./game-error');

async function prepareImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) {
    throw new GameError('Choose a JPEG, PNG or WebP image up to 5 MB.');
  }
  try {
    const image = sharp(buffer, { limitInputPixels: 20000000, failOn: 'warning', animated: true });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
      throw new GameError('Use a still JPEG, PNG or WebP image; animation and SVG uploads are not allowed.');
    }
    return await image.rotate().resize(1600, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer();
  } catch (error) {
    if (error instanceof GameError) throw error;
    throw new GameError('This image could not be decoded safely. Choose a valid still image under 20 megapixels.');
  }
}

function createImageStorage(env) {
  const keys = ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const configured = keys.filter(key => env[key]);
  if (!configured.length) return { configured: false, imageOrigin: null, close() {} };
  if (configured.length !== keys.length) throw new Error(`R2 requires all of: ${keys.join(', ')}.`);
  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) throw new Error('R2_ACCOUNT_ID must be the 32-character Cloudflare account ID.');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET_NAME)) throw new Error('R2_BUCKET_NAME must be a valid bucket name.');
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: 'auto', endpoint, forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    maxAttempts: 2, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  });
  return {
    configured: true, imageOrigin: endpoint,
    async upload(body, game = 'get-the-picture') {
      if (!['get-the-picture', 'screengrabbers'].includes(game)) throw new GameError('Choose a supported game image library.');
      const key = `${game}/${randomUUID()}.webp`;
      await client.send(new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME, Key: key, Body: body, ContentType: 'image/webp',
        CacheControl: 'private, max-age=3600',
      }));
      return key;
    },
    url: key => getSignedUrl(client, new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME, Key: key,
    }), { expiresIn: 3600 }),
    remove: key => client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key })),
    close() { client.destroy(); },
  };
}

module.exports = { createImageStorage, prepareImage };
