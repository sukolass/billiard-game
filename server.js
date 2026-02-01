const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const Matter = require('matter-js');

app.use(express.static('public'));

// -------------------------------------------------------------------------- //
//                               PHYSICS SETUP                                //
// -------------------------------------------------------------------------- //

const Engine = Matter.Engine,
    World = Matter.World,
    Bodies = Matter.Bodies,
    Body = Matter.Body,
    Events = Matter.Events,
    Vector = Matter.Vector,
    Composite = Matter.Composite;

const engine = Engine.create();
engine.world.gravity.y = 0; // Top-down -> no gravity
const world = engine.world;

const TABLE_WIDTH = 1600;
const TABLE_HEIGHT = 900;
const WALL_THICKNESS = 100;

// Game constants
const BALL_RADIUS = 20;
const PLAYER_BALL_RADIUS = 28;
const BLACK_BALL_RADIUS = 22;
const COOLDOWN_TIME = 750; // ms

// -------------------------------------------------------------------------- //
//                                WORLD SETUP                                 //
// -------------------------------------------------------------------------- //

// 4 Walls
const walls = [
    Bodies.rectangle(TABLE_WIDTH / 2, -WALL_THICKNESS / 2, TABLE_WIDTH + 2 * WALL_THICKNESS, WALL_THICKNESS, { isStatic: true, label: 'Wall' }),
    Bodies.rectangle(TABLE_WIDTH / 2, TABLE_HEIGHT + WALL_THICKNESS / 2, TABLE_WIDTH + 2 * WALL_THICKNESS, WALL_THICKNESS, { isStatic: true, label: 'Wall' }),
    Bodies.rectangle(-WALL_THICKNESS / 2, TABLE_HEIGHT / 2, WALL_THICKNESS, TABLE_HEIGHT + 2 * WALL_THICKNESS, { isStatic: true, label: 'Wall' }),
    Bodies.rectangle(TABLE_WIDTH + WALL_THICKNESS / 2, TABLE_HEIGHT / 2, WALL_THICKNESS, TABLE_HEIGHT + 2 * WALL_THICKNESS, { isStatic: true, label: 'Wall' })
];
World.add(world, walls);

// 6 Holes (Sensors)
const holeSensorOptions = {
    isStatic: true,
    isSensor: true,
    label: 'Hole',
    render: { visible: false }
};
const holeRadius = 45;
const holePositions = [
    { x: 0, y: 0 }, { x: TABLE_WIDTH / 2, y: 0 }, { x: TABLE_WIDTH, y: 0 },
    { x: 0, y: TABLE_HEIGHT }, { x: TABLE_WIDTH / 2, y: TABLE_HEIGHT }, { x: TABLE_WIDTH, y: TABLE_HEIGHT }
];
const holes = holePositions.map(pos => Bodies.circle(pos.x, pos.y, holeRadius, holeSensorOptions));
World.add(world, holes);


// -------------------------------------------------------------------------- //
//                               GAME STATE                                   //
// -------------------------------------------------------------------------- //

let players = {}; // socket.id -> { body, score, cooldown, name, color }
let scoreBalls = []; // Track score balls
let blackBall = null;
let gameActive = false;

function createScoreBall() {
    const x = Math.random() * (TABLE_WIDTH - 200) + 100;
    const y = Math.random() * (TABLE_HEIGHT - 200) + 100;
    const ball = Bodies.circle(x, y, BALL_RADIUS, {
        restitution: 0.9,
        friction: 0.005,
        frictionAir: 0.008,
        label: 'ScoreBall',
        render: { fillStyle: (Math.random() > 0.5 ? 'white' : '#ff3333') }
    });
    ball.lastTouchedBy = null;
    return ball;
}

function createBlackBall() {
    const ball = Bodies.circle(TABLE_WIDTH / 2, TABLE_HEIGHT / 2, BLACK_BALL_RADIUS, {
        restitution: 0.9,
        friction: 0.005,
        frictionAir: 0.008,
        density: 0.004,
        label: 'BlackBall',
        render: { fillStyle: 'black' }
    });
    ball.lastTouchedBy = null;
    return ball;
}

function startGame(ballCount) {
    // Clear existing balls
    scoreBalls.forEach(ball => World.remove(world, ball));
    if (blackBall) World.remove(world, blackBall);

    scoreBalls = [];

    // Create new balls
    for (let i = 0; i < ballCount; i++) {
        const ball = createScoreBall();
        scoreBalls.push(ball);
        World.add(world, ball);
    }

    // Create black ball
    blackBall = createBlackBall();
    World.add(world, blackBall);

    // Reset all player scores
    for (let id in players) {
        players[id].score = 0;
    }

    gameActive = true;
    console.log(`Game started with ${ballCount} balls`);
}

// Start with default balls
startGame(15);

function respawnScoreBall(ball) {
    Body.setPosition(ball, {
        x: Math.random() * (TABLE_WIDTH - 200) + 100,
        y: Math.random() * (TABLE_HEIGHT - 200) + 100
    });
    Body.setVelocity(ball, { x: 0, y: 0 });
    ball.lastTouchedBy = null;
}

function respawnBlackBall() {
    Body.setPosition(blackBall, { x: TABLE_WIDTH / 2, y: TABLE_HEIGHT / 2 });
    Body.setVelocity(blackBall, { x: 0, y: 0 });
    blackBall.lastTouchedBy = null;
}

function respawnPlayer(playerBody) {
    Body.setPosition(playerBody, {
        x: Math.random() * (TABLE_WIDTH - 200) + 100,
        y: Math.random() * (TABLE_HEIGHT - 200) + 100
    });
    Body.setVelocity(playerBody, { x: 0, y: 0 });
    playerBody.lastTouchedBy = null;
}


// -------------------------------------------------------------------------- //
//                                  LOGIC                                     //
// -------------------------------------------------------------------------- //

Events.on(engine, 'collisionStart', (event) => {
    const pairs = event.pairs;

    for (let i = 0; i < pairs.length; i++) {
        const bodyA = pairs[i].bodyA;
        const bodyB = pairs[i].bodyB;

        // Hole Collision
        let hole = null;
        let ball = null;

        if (bodyA.label === 'Hole') { hole = bodyA; ball = bodyB; }
        else if (bodyB.label === 'Hole') { hole = bodyB; ball = bodyA; }

        if (hole && ball) {
            handleHoleCollision(ball);
            continue;
        }

        // Ball-Ball Touch (for scoring attribution)
        let playerBody = null;
        let otherBody = null;

        if (bodyA.label === 'PlayerBall') { playerBody = bodyA; otherBody = bodyB; }
        else if (bodyB.label === 'PlayerBall') { playerBody = bodyB; otherBody = bodyA; }

        if (playerBody) {
            if (otherBody.label !== 'Wall' && otherBody.label !== 'Hole') {
                otherBody.lastTouchedBy = playerBody.playerId;
            }
        }
    }
});

function handleHoleCollision(ball) {
    if (ball.label === 'ScoreBall') {
        if (ball.lastTouchedBy && players[ball.lastTouchedBy]) {
            players[ball.lastTouchedBy].score += 1;
        }
        respawnScoreBall(ball);
    }
    else if (ball.label === 'PlayerBall') {
        const victimId = ball.playerId;
        if (players[victimId]) {
            players[victimId].score -= 5;

            const killerId = ball.lastTouchedBy;
            if (killerId && killerId !== victimId && players[killerId]) {
                players[killerId].score += 10;
            }
            respawnPlayer(ball);
        }
    }
    else if (ball.label === 'BlackBall') {
        if (ball.lastTouchedBy && players[ball.lastTouchedBy]) {
            players[ball.lastTouchedBy].score = 0;
        }
        respawnBlackBall();
    }
}


// -------------------------------------------------------------------------- //
//                                SOCKET.IO                                   //
// -------------------------------------------------------------------------- //

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Handle game start from lobby
    socket.on('startGame', (data) => {
        const ballCount = Math.min(Math.max(data.ballCount || 15, 5), 50);
        startGame(ballCount);
        io.emit('gameStarted', { ballCount });
    });

    // Create player ball when they want to play
    socket.on('joinGame', () => {
        if (players[socket.id]) return; // Already joined

        const hue = Math.floor(Math.random() * 360);
        const color = `hsl(${hue}, 70%, 50%)`;

        const playerBall = Bodies.circle(
            Math.random() * (TABLE_WIDTH - 200) + 100,
            Math.random() * (TABLE_HEIGHT - 200) + 100,
            PLAYER_BALL_RADIUS,
            {
                restitution: 0.9,
                friction: 0.005,
                frictionAir: 0.008,
                label: 'PlayerBall',
            }
        );
        playerBall.playerId = socket.id;
        playerBall.lastTouchedBy = null;
        playerBall.render.fillStyle = color;

        World.add(world, playerBall);

        players[socket.id] = {
            body: playerBall,
            score: 0,
            cooldown: 0,
            name: "P-" + socket.id.substr(0, 4),
            color: color
        };

        socket.emit('joined', { id: socket.id, color });
    });

    // Auto-join for controller
    socket.on('autoJoin', () => {
        socket.emit('init', { id: socket.id });

        if (!players[socket.id]) {
            const hue = Math.floor(Math.random() * 360);
            const color = `hsl(${hue}, 70%, 50%)`;

            const playerBall = Bodies.circle(
                Math.random() * (TABLE_WIDTH - 200) + 100,
                Math.random() * (TABLE_HEIGHT - 200) + 100,
                PLAYER_BALL_RADIUS,
                {
                    restitution: 0.9,
                    friction: 0.005,
                    frictionAir: 0.008,
                    label: 'PlayerBall',
                }
            );
            playerBall.playerId = socket.id;
            playerBall.lastTouchedBy = null;
            playerBall.render.fillStyle = color;

            World.add(world, playerBall);

            players[socket.id] = {
                body: playerBall,
                score: 0,
                cooldown: 0,
                name: "P-" + socket.id.substr(0, 4),
                color: color
            };
        }
    });

    socket.on('shoot', (data) => {
        const player = players[socket.id];
        if (!player) return;

        const now = Date.now();
        if (now >= player.cooldown) {
            // 0.3 = good balance of speed and control
            const forceMag = (data.force || 0) * 0.3;
            const angle = data.angle || 0;

            const force = Vector.create(Math.cos(angle) * forceMag, Math.sin(angle) * forceMag);
            Body.applyForce(player.body, player.body.position, force);

            player.cooldown = now + COOLDOWN_TIME;
            socket.emit('cooldownNotify', { duration: COOLDOWN_TIME });
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const player = players[socket.id];
        if (player) {
            World.remove(world, player.body);
            delete players[socket.id];
        }
    });
});


// -------------------------------------------------------------------------- //
//                                SERVER LOOP                                 //
// -------------------------------------------------------------------------- //

const TICK_RATE = 1000 / 60;
setInterval(() => {
    Engine.update(engine, TICK_RATE);

    // Pack Data
    const allBodies = Composite.allBodies(world);
    const ballData = [];

    for (let b of allBodies) {
        if (b.label === 'Wall' || b.label === 'Hole') continue;

        ballData.push({
            id: b.id,
            x: Math.round(b.position.x),
            y: Math.round(b.position.y),
            angle: b.angle,
            label: b.label,
            color: b.render.fillStyle,
            r: b.circleRadius,
            playerId: b.playerId || null
        });
    }

    const playerData = {};
    const now = Date.now();
    for (let id in players) {
        playerData[id] = {
            score: players[id].score,
            name: players[id].name,
            color: players[id].color,
            cooldownProgress: (now < players[id].cooldown) ? (players[id].cooldown - now) / COOLDOWN_TIME : 0
        };
    }

    io.emit('gameState', {
        balls: ballData,
        players: playerData
    });

}, TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
