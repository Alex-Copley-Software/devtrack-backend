// r2.js — Cloudflare R2 storage service
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const ACCOUNT_ID   = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY   = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY   = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET       = process.env.R2_BUCKET_NAME || 'devtrack-media';
const PUBLIC_URL   = process.env.R2_PUBLIC_URL;  // https://pub-xxx.r2.dev

let client = null;

function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
      },
    });
  }
  return client;
}

function isConfigured() {
  return !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && PUBLIC_URL);
}

function isPrivateConfigured(bucket) {
  return !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && bucket);
}

/**
 * Upload a local file to R2
 * Returns the public URL or null on failure
 */
async function uploadFile(localPath, key, mimeType) {
  if (!isConfigured()) {
    console.warn('[R2] Not configured — skipping upload, using local path');
    return null;
  }
  try {
    const body = fs.readFileSync(localPath);
    await getClient().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: mimeType || 'application/octet-stream',
    }));
    const url = `${PUBLIC_URL}/${key}`;
    console.log(`[R2] Uploaded: ${key} → ${url}`);
    return url;
  } catch (err) {
    console.error('[R2] Upload failed:', err.message);
    return null;
  }
}

/**
 * Upload a buffer directly to R2 (from Discord CDN download)
 * Returns the public URL or null on failure
 */
async function uploadBuffer(buffer, key, mimeType) {
  if (!isConfigured()) return null;
  try {
    await getClient().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream',
    }));
    const url = `${PUBLIC_URL}/${key}`;
    console.log(`[R2] Uploaded buffer: ${key}`);
    return url;
  } catch (err) {
    console.error('[R2] Buffer upload failed:', err.message);
    return null;
  }
}

async function uploadPrivateFile(localPath, key, mimeType, bucket) {
  if (!isPrivateConfigured(bucket)) return null;
  try {
    const body = fs.readFileSync(localPath);
    await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimeType || 'application/octet-stream',
    }));
    console.log(`[R2] Uploaded private file: ${bucket}/${key}`);
    return key;
  } catch (err) {
    console.error('[R2] Private upload failed:', err.message);
    return null;
  }
}

async function getPrivateObject(key, bucket) {
  if (!isPrivateConfigured(bucket)) return null;
  return getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

async function deletePrivateObject(key, bucket) {
  if (!isPrivateConfigured(bucket)) return false;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    console.error('[R2] Private delete failed:', err.message);
    return false;
  }
}

module.exports = {
  uploadFile,
  uploadBuffer,
  uploadPrivateFile,
  getPrivateObject,
  deletePrivateObject,
  isConfigured,
  isPrivateConfigured,
};
