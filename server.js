const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── CONFIGURAÇÃO ──
const COOLDOWN_MS = 60 * 1000; // 1 mensagem por minuto

// ── ESTADO DA FILA ──
let fila = [];
let processando = false;
let ultimoEnvio = 0;
let historico = []; // últimas 50 mensagens enviadas
let contadorId = 1;

// ── CLIENTES SSE ──
const clientes = new Set();

function emitirParaTodos(evento, dados) {
    const payload = `data: ${JSON.stringify({ evento, ts: new Date().toISOString(), ...dados })}\n\n`;
    for (const res of clientes) {
        try { res.write(payload); }
        catch (_) { clientes.delete(res); }
    }
}

function estadoAtual() {
    return {
        fila: fila.map(item => ({
            id: item.id,
            origem: item.origem,
            nome: item.nome,
            telefone: item.telefone,
            preview: item.preview,
            imediato: item.imediato,
            entrou_em: item.entrou_em,
        })),
        processando,
        ultimoEnvio: ultimoEnvio ? new Date(ultimoEnvio).toISOString() : null,
        historico,
    };
}

// ── SLEEP ──
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── ENVIO REAL VIA EVOLUTION API ──
async function enviarWhatsApp(numero, mensagem) {
    const evolutionUrl = process.env.EVOLUTION_URL;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const instance = encodeURIComponent(process.env.EVOLUTION_INSTANCE);

    await axios.post(
        `${evolutionUrl}/message/sendText/${instance}`,
        { number: numero, text: mensagem },
        { headers: { apikey: apiKey, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
}

// ── PROCESSADOR DA FILA ──
async function processar() {
    if (processando) return;
    if (!fila.length) return;

    processando = true;
    emitirParaTodos('fila_atualizada', estadoAtual());

    while (fila.length > 0) {
        // Verifica se o próximo é imediato
        const proximo = fila[0];

        if (!proximo.imediato) {
            const agora = Date.now();
            const espera = COOLDOWN_MS - (agora - ultimoEnvio);
            if (espera > 0 && ultimoEnvio > 0) {
                emitirParaTodos('aguardando', {
                    segundos: Math.ceil(espera / 1000),
                    proximo: proximo.nome,
                });
                await sleep(espera);
            }
        }

        // Verifica se foi cancelado enquanto esperava
        if (!fila.length || fila[0].id !== proximo.id) continue;

        const item = fila.shift();

        emitirParaTodos('enviando', {
            id: item.id,
            nome: item.nome,
            telefone: item.telefone,
            origem: item.origem,
        });

        try {
            await enviarWhatsApp(item.telefone, item.mensagem);
            ultimoEnvio = Date.now();

            const registro = {
                id: item.id,
                origem: item.origem,
                nome: item.nome,
                telefone: item.telefone,
                preview: item.preview,
                enviado_em: new Date().toISOString(),
                sucesso: true,
            };
            historico.unshift(registro);
            if (historico.length > 50) historico.pop();

            emitirParaTodos('enviado', registro);
            console.log(`✅ Enviado para ${item.nome} (${item.telefone}) | origem: ${item.origem}`);

        } catch (err) {
            ultimoEnvio = Date.now();
            const registro = {
                id: item.id,
                origem: item.origem,
                nome: item.nome,
                telefone: item.telefone,
                preview: item.preview,
                enviado_em: new Date().toISOString(),
                sucesso: false,
                erro: err.message,
            };
            historico.unshift(registro);
            if (historico.length > 50) historico.pop();

            emitirParaTodos('erro_envio', registro);
            console.error(`❌ Erro ao enviar para ${item.nome}: ${err.message}`);
        }

        emitirParaTodos('fila_atualizada', estadoAtual());
    }

    processando = false;
    emitirParaTodos('fila_atualizada', estadoAtual());
}

// ── AUTENTICAÇÃO SIMPLES ──
function autenticar(req, res, next) {
    const token = req.headers['x-gateway-token'];
    if (!token || token !== process.env.GATEWAY_TOKEN) {
        return res.status(401).json({ error: 'Token inválido' });
    }
    next();
}

// ── ENDPOINTS ──

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        fila: fila.length,
        processando,
        ultimoEnvio: ultimoEnvio ? new Date(ultimoEnvio).toISOString() : null,
    });
});

// Enfileirar mensagem
// POST /enviar
// Body: { telefone, mensagem, nome, origem, imediato? }
app.post('/enviar', autenticar, (req, res) => {
    const { telefone, mensagem, nome, origem, imediato } = req.body;

    if (!telefone || !mensagem) {
        return res.status(400).json({ error: 'telefone e mensagem são obrigatórios' });
    }

    const id = contadorId++;
    const preview = mensagem.substring(0, 60).replace(/\n/g, ' ');

    const item = {
        id,
        telefone,
        mensagem,
        nome: nome || telefone,
        origem: origem || 'desconhecido',
        preview,
        imediato: !!imediato,
        entrou_em: new Date().toISOString(),
    };

    if (imediato) {
        // Imediato: entra na frente da fila
        fila.unshift(item);
        console.log(`⚡ IMEDIATO enfileirado: ${item.nome} | ${item.origem}`);
    } else {
        fila.push(item);
        console.log(`📥 Enfileirado: ${item.nome} | ${item.origem} | posição ${fila.length}`);
    }

    const posicao = fila.findIndex(i => i.id === id) + 1;
    emitirParaTodos('fila_atualizada', estadoAtual());

    processar();

    res.json({ success: true, id, posicao, imediato: !!imediato });
});

// Cancelar mensagem da fila
// DELETE /fila/:id
app.delete('/fila/:id', autenticar, (req, res) => {
    const id = parseInt(req.params.id);
    const idx = fila.findIndex(i => i.id === id);

    if (idx === -1) {
        return res.status(404).json({ error: 'Mensagem não encontrada na fila' });
    }

    const [removido] = fila.splice(idx, 1);
    console.log(`🗑️ Cancelado da fila: ${removido.nome} (id ${id})`);
    emitirParaTodos('fila_atualizada', estadoAtual());

    res.json({ success: true, cancelado: removido.nome });
});

// Estado atual da fila (REST)
app.get('/fila', autenticar, (req, res) => {
    res.json(estadoAtual());
});

// SSE — stream em tempo real
// GET /eventos
app.get('/eventos', autenticar, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Envia estado atual ao conectar
    res.write(`data: ${JSON.stringify({ evento: 'conectado', ts: new Date().toISOString(), ...estadoAtual() })}\n\n`);

    clientes.add(res);
    console.log(`📡 SSE conectado | total: ${clientes.size}`);

    // Keepalive a cada 30s
    const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); }
        catch (_) { clearInterval(keepalive); }
    }, 30000);

    req.on('close', () => {
        clientes.delete(res);
        clearInterval(keepalive);
        console.log(`📡 SSE desconectado | total: ${clientes.size}`);
    });
});

// ── INICIALIZAÇÃO ──
app.listen(PORT, () => {
    console.log(`\n🚀 Gateway WhatsApp rodando na porta ${PORT}`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📥 Enviar: POST http://localhost:${PORT}/enviar`);
    console.log(`📡 Eventos: GET http://localhost:${PORT}/eventos`);
    console.log(`🗑️  Cancelar: DELETE http://localhost:${PORT}/fila/:id\n`);

    if (!process.env.EVOLUTION_URL) console.warn('⚠️  EVOLUTION_URL não configurado');
    if (!process.env.EVOLUTION_API_KEY) console.warn('⚠️  EVOLUTION_API_KEY não configurado');
    if (!process.env.EVOLUTION_INSTANCE) console.warn('⚠️  EVOLUTION_INSTANCE não configurado');
    if (!process.env.GATEWAY_TOKEN) console.warn('⚠️  GATEWAY_TOKEN não configurado');
});

process.on('uncaughtException', err => { console.error('💥 UncaughtException:', err); });
process.on('unhandledRejection', reason => { console.error('💥 UnhandledRejection:', reason); });
