'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const GAME_FILE = path.join(__dirname, 'ruiny-rozkazy.html');
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function reply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) { reject(new Error('Żądanie jest za duże')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Niepoprawne dane')); }
    });
    req.on('error', reject);
  });
}
function newCode() {
  for (let tries = 0; tries < 100; tries++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Nie udało się utworzyć pokoju');
}
function newPlayerId() { return crypto.randomBytes(18).toString('base64url'); }
function getRoom(code) {
  const room = rooms.get(code);
  if (!room) return null;
  if (Date.now() - room.lastActivity > 30 * 60 * 1000) { rooms.delete(code); return null; }
  room.lastActivity = Date.now();
  return room;
}
function playerFor(room, id) { return room.players.find(p => p.id === id); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/health') return reply(res, 200, { ok: true });
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ruiny-rozkazy.html')) {
    fs.readFile(GAME_FILE, (err, html) => {
      if (err) return reply(res, 500, { error: 'Nie można odczytać pliku gry' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    try {
      await readBody(req);
      const code = newCode();
      const host = { id: newPlayerId(), team: 'blue', lastSeen: Date.now() };
      rooms.set(code, { code, players: [host], started: false, snapshot: null, stateVersion: 0, actions: [], nextAction: 1, lastActivity: Date.now() });
      return reply(res, 201, { code, playerId: host.id, team: host.team, started: false });
    } catch (error) { return reply(res, 400, { error: error.message }); }
  }
  const match = url.pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/(join|state|action|poll|leave)$/);
  if (!match) return reply(res, 404, { error: 'Nie znaleziono adresu' });
  const [, code, operation] = match;
  const room = getRoom(code);
  if (!room) return reply(res, 404, { error: 'Pokój nie istnieje albo wygasł' });

  if (req.method === 'POST' && operation === 'join') {
    try {
      await readBody(req);
      if (room.players[0] && Date.now() - room.players[0].lastSeen > 15000) { rooms.delete(code); return reply(res, 410, { error: 'Prowadzący opuścił pokój' }); }
      room.players = room.players.filter(p => p.team === 'blue' || Date.now() - p.lastSeen < 5000);
      if (room.players.length < 2) { room.started = false; room.snapshot = null; room.actions = []; room.nextAction = 1; }
      if (room.players.length >= 2) return reply(res, 409, { error: 'Pokój jest już pełny' });
      const guest = { id: newPlayerId(), team: 'red', lastSeen: Date.now() };
      room.players.push(guest);
      room.started = true;
      return reply(res, 200, { code, playerId: guest.id, team: guest.team, started: true });
    } catch (error) { return reply(res, 400, { error: error.message }); }
  }
  if (operation === 'poll' && req.method === 'GET') {
    const id = url.searchParams.get('playerId');
    const player = playerFor(room, id);
    if (!player) return reply(res, 403, { error: 'Nie należysz do tego pokoju' });
    player.lastSeen = Date.now();
    const sinceAction = Number(url.searchParams.get('sinceAction') || 0);
    const sinceState = Number(url.searchParams.get('sinceState') || 0);
    const result = {
      started: room.started,
      playerCount: room.players.filter(p => Date.now() - p.lastSeen < 5000).length,
      actions: player.team === 'blue' ? room.actions.filter(a => a.seq > sinceAction && a.playerId !== id) : [],
      lastAction: room.nextAction - 1,
      stateVersion: room.stateVersion
    };
    if (player.team === 'red' && room.snapshot && room.stateVersion > sinceState) result.snapshot = room.snapshot;
    return reply(res, 200, result);
  }
  if (req.method === 'POST' && operation === 'state') {
    try {
      const data = await readBody(req);
      const player = playerFor(room, data.playerId);
      if (!player || player.team !== 'blue') return reply(res, 403, { error: 'Tylko prowadzący pokój wysyła stan gry' });
      player.lastSeen = Date.now();
      room.snapshot = data.snapshot;
      room.stateVersion++;
      return reply(res, 200, { ok: true, stateVersion: room.stateVersion });
    } catch (error) { return reply(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && operation === 'action') {
    try {
      const data = await readBody(req);
      const player = playerFor(room, data.playerId);
      if (!player || player.team !== 'red') return reply(res, 403, { error: 'Nie można wysłać rozkazu' });
      player.lastSeen = Date.now();
      room.actions.push({ seq: room.nextAction++, playerId: player.id, team: player.team, command: data.command });
      if (room.actions.length > 300) room.actions.splice(0, room.actions.length - 300);
      return reply(res, 200, { ok: true });
    } catch (error) { return reply(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && operation === 'leave') {
    try {
      const data = await readBody(req);
      const player = playerFor(room, data.playerId);
      if (!player) return reply(res, 200, { ok: true });
      if (player.team === 'blue') rooms.delete(code);
      else { room.players = room.players.filter(p => p.id !== player.id); room.started = false; room.snapshot = null; room.actions = []; room.nextAction = 1; }
      return reply(res, 200, { ok: true });
    } catch (error) { return reply(res, 400, { error: error.message }); }
  }
  return reply(res, 405, { error: 'Niedozwolona metoda' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`RUINY.seba działa na porcie ${PORT}`));