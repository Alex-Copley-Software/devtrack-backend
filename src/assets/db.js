// One shared Prisma client for the asset tracker. Tests and the local demo
// server swap in an in-process Postgres through setPrisma().

let prisma = null;

function getPrisma() {
  if (!prisma) {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  }
  return prisma;
}

function setPrisma(client) {
  prisma = client;
}

const newId = () => require('crypto').randomUUID();

module.exports = { getPrisma, setPrisma, newId };
