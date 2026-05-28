const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── GAME STATE ───────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const VALUES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const MAX_PLAYERS = 8;

let deck = [];
let players = {}; // id -> { ws, name, hand, bet, balance, status, ready }
let dealerHand = [];
let gamePhase = 'waiting'; // waiting | betting | playing | dealer | results
let currentPlayerIndex = 0;
let playerOrder = [];

function buildDeck() {
  deck = [];
  for (let s of SUITS) for (let v of VALUES) deck.push({ s, v });
  // Use 6 decks
  deck = [...deck, ...deck, ...deck, ...deck, ...deck, ...deck];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function cardVal(c) {
  if (['J','Q','K'].includes(c.v)) return 10;
  if (c.v === 'A') return 11;
  return parseInt(c.v);
}

function handScore(hand) {
  let score = 0, aces = 0;
  for (let c of hand) {
    if (c.hidden) continue;
    if (c.v === 'A') aces++;
    score += cardVal(c);
  }
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  Object.values(players).forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

function getPublicState(forId = null) {
  const pub = {};
  for (let [id, p] of Object.entries(players)) {
    pub[id] = {
      name: p.name,
      hand: id === forId ? p.hand : p.hand.map(c => c.hidden ? { hidden: true } : c),
      bet: p.bet,
      balance: p.balance,
      status: p.status,
      score: handScore(p.hand.filter(c => !c.hidden)),
      isCurrentTurn: playerOrder[currentPlayerIndex] === id
    };
  }
  return pub;
}

function broadcastState() {
  for (let [id, p] of Object.entries(players)) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({
        type: 'state',
        phase: gamePhase,
        players: getPublicState(id),
        dealer: {
          hand: dealerHand,
          score: handScore(dealerHand.filter(c => !c.hidden))
        },
        currentTurn: playerOrder[currentPlayerIndex] || null,
        myId: id
      }));
    }
  }
}

function startBetting() {
  gamePhase = 'betting';
  Object.values(players).forEach(p => {
    p.bet = 0;
    p.hand = [];
    p.status = 'betting';
  });
  dealerHand = [];
  broadcast({ type: 'phase', phase: 'betting', msg: 'Piazza le puntate!' });
  broadcastState();
}

function allBetsPlaced() {
  return Object.values(players).every(p => p.bet > 0 && p.status === 'bet_placed');
}

function dealCards() {
  if (deck.length < 50) buildDeck();
  gamePhase = 'playing';
  playerOrder = Object.keys(players);
  currentPlayerIndex = 0;

  // Deal 2 cards to each player and dealer
  playerOrder.forEach(id => {
    players[id].hand = [deck.pop(), deck.pop()];
    players[id].status = 'playing';
    players[id].balance -= players[id].bet;
  });
  dealerHand = [deck.pop(), { ...deck.pop(), hidden: true }];

  broadcastState();
  broadcast({ type: 'phase', phase: 'playing', msg: 'La partita è iniziata!' });
  nextTurn();
}

function nextTurn() {
  // Skip busted/stood players
  while (
    currentPlayerIndex < playerOrder.length &&
    ['bust', 'stand', 'blackjack'].includes(players[playerOrder[currentPlayerIndex]]?.status)
  ) {
    currentPlayerIndex++;
  }

  if (currentPlayerIndex >= playerOrder.length) {
    dealerTurn();
    return;
  }

  const currentId = playerOrder[currentPlayerIndex];
  const p = players[currentId];

  // Auto-blackjack
  if (handScore(p.hand) === 21) {
    p.status = 'blackjack';
    broadcastState();
    broadcast({ type: 'msg', msg: `🃏 ${p.name} ha Blackjack!` });
    setTimeout(() => { currentPlayerIndex++; nextTurn(); }, 1000);
    return;
  }

  broadcast({ type: 'your_turn', playerId: currentId, name: p.name });
  broadcastState();
}

function dealerTurn() {
  gamePhase = 'dealer';
  dealerHand = dealerHand.map(c => ({ ...c, hidden: false }));
  broadcastState();

  function dealerStep() {
    const score = handScore(dealerHand);
    if (score < 17) {
      dealerHand.push(deck.pop());
      broadcastState();
      setTimeout(dealerStep, 800);
    } else {
      resolveGame();
    }
  }
  setTimeout(dealerStep, 800);
}

function resolveGame() {
  gamePhase = 'results';
  const dealerScore = handScore(dealerHand);
  const dealerBust = dealerScore > 21;

  for (let [id, p] of Object.entries(players)) {
    const ps = handScore(p.hand);
    const playerBJ = ps === 21 && p.hand.length === 2;
    const dealerBJ = dealerScore === 21 && dealerHand.length === 2;

    if (p.status === 'bust') {
      p.result = 'lose';
    } else if (playerBJ && !dealerBJ) {
      p.result = 'blackjack';
      p.balance += Math.floor(p.bet * 2.5);
    } else if (playerBJ && dealerBJ) {
      p.result = 'push';
      p.balance += p.bet;
    } else if (dealerBust || ps > dealerScore) {
      p.result = 'win';
      p.balance += p.bet * 2;
    } else if (ps === dealerScore) {
      p.result = 'push';
      p.balance += p.bet;
    } else {
      p.result = 'lose';
    }
  }

  broadcastState();
  broadcast({ type: 'phase', phase: 'results', dealerScore });

  // Auto restart after 5 seconds if players remain
  setTimeout(() => {
    if (Object.keys(players).length > 0) startBetting();
  }, 6000);
}

// ─── WEBSOCKET ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  if (Object.keys(players).length >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', msg: 'Tavolo pieno (max 8 giocatori)' }));
    ws.close();
    return;
  }

  const id = Math.random().toString(36).substr(2, 9);
  players[id] = { ws, name: `Giocatore`, hand: [], bet: 0, balance: 1000, status: 'waiting', result: null };

  ws.send(JSON.stringify({ type: 'welcome', id, playerCount: Object.keys(players).length }));
  broadcast({ type: 'player_joined', count: Object.keys(players).length });
  broadcastState();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = players[id];
    if (!p) return;

    switch (msg.type) {
      case 'set_name':
        p.name = msg.name.substring(0, 20);
        broadcastState();
        break;

      case 'start_game':
        if (Object.keys(players).length >= 1 && gamePhase === 'waiting') {
          buildDeck();
          startBetting();
        }
        break;

      case 'place_bet':
        if (gamePhase === 'betting' && p.status === 'betting') {
          const amt = parseInt(msg.amount);
          if (amt > 0 && amt <= p.balance) {
            p.bet = amt;
            p.status = 'bet_placed';
            broadcastState();
            if (allBetsPlaced()) setTimeout(dealCards, 1000);
          }
        }
        break;

      case 'hit':
        if (gamePhase === 'playing' && playerOrder[currentPlayerIndex] === id && p.status === 'playing') {
          p.hand.push(deck.pop());
          const score = handScore(p.hand);
          if (score > 21) {
            p.status = 'bust';
            broadcastState();
            broadcast({ type: 'msg', msg: `💥 ${p.name} è sballato!` });
            setTimeout(() => { currentPlayerIndex++; nextTurn(); }, 800);
          } else if (score === 21) {
            p.status = 'stand';
            broadcastState();
            setTimeout(() => { currentPlayerIndex++; nextTurn(); }, 800);
          } else {
            broadcastState();
          }
        }
        break;

      case 'stand':
        if (gamePhase === 'playing' && playerOrder[currentPlayerIndex] === id && p.status === 'playing') {
          p.status = 'stand';
          broadcastState();
          currentPlayerIndex++;
          nextTurn();
        }
        break;

      case 'double':
        if (gamePhase === 'playing' && playerOrder[currentPlayerIndex] === id && p.status === 'playing' && p.hand.length === 2 && p.bet <= p.balance) {
          p.balance -= p.bet;
          p.bet *= 2;
          p.hand.push(deck.pop());
          const score = handScore(p.hand);
          p.status = score > 21 ? 'bust' : 'stand';
          broadcastState();
          if (score > 21) broadcast({ type: 'msg', msg: `💥 ${p.name} è sballato!` });
          setTimeout(() => { currentPlayerIndex++; nextTurn(); }, 800);
        }
        break;
    }
  });

  ws.on('close', () => {
    delete players[id];
    broadcast({ type: 'player_left', count: Object.keys(players).length });
    if (Object.keys(players).length === 0) {
      gamePhase = 'waiting';
      playerOrder = [];
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Blackjack server running on port ${PORT}`));
