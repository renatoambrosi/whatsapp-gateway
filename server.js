const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── ESTADO GLOBAL ──
let cooldownMs = 60 * 1000;
let pausado = false;
let fila = [];
let processando = false;
let ultimoEnvio = 0;
let historico = [];
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
            id: item.id, origem: item.origem, nome: item.nome,
            telefone: item.telefone, preview: item.preview,
            imediato: item.imediato, entrou_em: item.entrou_em,
        })),
        processando, pausado, cooldownMs,
        ultimoEnvio: ultimoEnvio ? new Date(ultimoEnvio).toISOString() : null,
        historico,
    };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

async function processar() {
    if (processando) return;
    if (!fila.length) return;

    processando = true;
    emitirParaTodos('fila_atualizada', estadoAtual());

    while (fila.length > 0) {
        // Aguarda enquanto pausado
        while (pausado) {
            await sleep(2000);
        }

        const proximo = fila[0];

        if (!proximo.imediato) {
            const agora = Date.now();
            const espera = cooldownMs - (agora - ultimoEnvio);
            if (espera > 0 && ultimoEnvio > 0) {
                emitirParaTodos('aguardando', { segundos: Math.ceil(espera / 1000), proximo: proximo.nome });
                await sleep(espera);
            }
        }

        if (!fila.length || fila[0].id !== proximo.id) continue;
        if (pausado) continue;

        const item = fila.shift();
        emitirParaTodos('enviando', { id: item.id, nome: item.nome, telefone: item.telefone, origem: item.origem });

        try {
            await enviarWhatsApp(item.telefone, item.mensagem);
            ultimoEnvio = Date.now();
            const reg = { id: item.id, origem: item.origem, nome: item.nome, telefone: item.telefone, preview: item.preview, mensagemOriginal: item.mensagem, enviado_em: new Date().toISOString(), sucesso: true };
            historico.unshift(reg);
            if (historico.length > 50) historico.pop();
            emitirParaTodos('enviado', reg);
            console.log(`✅ ${item.nome} (${item.telefone}) | ${item.origem}`);
        } catch (err) {
            ultimoEnvio = Date.now();
            const reg = { id: item.id, origem: item.origem, nome: item.nome, telefone: item.telefone, preview: item.preview, mensagemOriginal: item.mensagem, enviado_em: new Date().toISOString(), sucesso: false, erro: err.message };
            historico.unshift(reg);
            if (historico.length > 50) historico.pop();
            emitirParaTodos('erro_envio', reg);
            console.error(`❌ ${item.nome}: ${err.message}`);
        }

        emitirParaTodos('fila_atualizada', estadoAtual());
    }

    processando = false;
    emitirParaTodos('fila_atualizada', estadoAtual());
}

// ── AUTH ──
function autenticarToken(req, res, next) {
    const token = req.headers['x-gateway-token'];
    if (!token || token !== process.env.GATEWAY_TOKEN) return res.status(401).json({ error: 'Token inválido' });
    next();
}

function autenticarBasic(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Gateway Monitor"');
        return res.status(401).send('Acesso negado');
    }
    const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Gateway Monitor"');
    return res.status(401).send('Usuário ou senha incorretos');
}

// ── API (token) ──

app.get('/health', (req, res) => res.json({ status: 'OK', fila: fila.length, processando, pausado, cooldownMs }));

app.post('/enviar', autenticarToken, (req, res) => {
    const { telefone, mensagem, nome, origem, imediato } = req.body;
    if (!telefone || !mensagem) return res.status(400).json({ error: 'telefone e mensagem são obrigatórios' });
    const id = contadorId++;
    const preview = mensagem.substring(0, 60).replace(/\n/g, ' ');
    const item = { id, telefone, mensagem, nome: nome || telefone, origem: origem || 'desconhecido', preview, imediato: !!imediato, entrou_em: new Date().toISOString() };
    if (imediato) fila.unshift(item);
    else fila.push(item);
    const posicao = fila.findIndex(i => i.id === id) + 1;
    emitirParaTodos('fila_atualizada', estadoAtual());
    processar();
    res.json({ success: true, id, posicao, imediato: !!imediato });
});

app.delete('/fila/:id', autenticarToken, (req, res) => {
    const id = parseInt(req.params.id);
    const idx = fila.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
    const [removido] = fila.splice(idx, 1);
    emitirParaTodos('fila_atualizada', estadoAtual());
    res.json({ success: true, cancelado: removido.nome });
});

app.get('/fila', autenticarToken, (req, res) => res.json(estadoAtual()));

app.get('/eventos', autenticarToken, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ evento: 'conectado', ts: new Date().toISOString(), ...estadoAtual() })}\n\n`);
    clientes.add(res);
    const kv = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(kv); } }, 30000);
    req.on('close', () => { clientes.delete(res); clearInterval(kv); });
});

// ── MONITOR (basic auth) ──

app.get('/monitor', autenticarBasic, (req, res) => res.sendFile(path.join(__dirname, 'monitor.html')));

app.get('/monitor/estado', autenticarBasic, (req, res) => res.json(estadoAtual()));

app.post('/monitor/pausar', autenticarBasic, (req, res) => {
    pausado = true;
    console.log('⏸️ Fila pausada');
    emitirParaTodos('config_atualizada', { pausado, cooldownMs });
    res.json({ success: true, pausado });
});

app.post('/monitor/retomar', autenticarBasic, (req, res) => {
    pausado = false;
    console.log('▶️ Fila retomada');
    emitirParaTodos('config_atualizada', { pausado, cooldownMs });
    processar();
    res.json({ success: true, pausado });
});

app.post('/monitor/cooldown', autenticarBasic, (req, res) => {
    const seg = parseInt(req.body.segundos);
    if (!seg || seg < 10 || seg > 600) return res.status(400).json({ error: 'Mínimo 10s, máximo 600s' });
    cooldownMs = seg * 1000;
    console.log(`⏱️ Cooldown → ${seg}s`);
    emitirParaTodos('config_atualizada', { pausado, cooldownMs });
    res.json({ success: true, cooldownMs });
});

app.delete('/monitor/fila/:id', autenticarBasic, (req, res) => {
    const id = parseInt(req.params.id);
    const idx = fila.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
    const [removido] = fila.splice(idx, 1);
    emitirParaTodos('fila_atualizada', estadoAtual());
    res.json({ success: true, cancelado: removido.nome });
});

// Reenviar mensagem com erro — volta para o fim da fila (manual, sem retry automático)
app.post('/monitor/reenviar/:id', autenticarBasic, (req, res) => {
    const id = parseInt(req.params.id);
    const item = historico.find(h => h.id === id && !h.sucesso);
    if (!item) return res.status(404).json({ error: 'Mensagem não encontrada no histórico de erros' });

    // Busca a mensagem original no histórico completo (preview não tem o texto completo)
    // Como o historico só guarda preview, precisamos guardar o texto original tb
    // Por segurança, remove do histórico e adiciona de volta na fila com os dados disponíveis
    const novoItem = {
        id: contadorId++,
        telefone: item.telefone,
        mensagem: item.mensagemOriginal || item.preview, // usa original se disponível
        nome: item.nome,
        origem: item.origem,
        preview: item.preview,
        imediato: false,
        entrou_em: new Date().toISOString(),
    };

    fila.push(novoItem);
    // Remove do histórico
    historico = historico.filter(h => h.id !== id);

    console.log(`↩️ Reenviado para fila: ${item.nome} (id original: ${id})`);
    emitirParaTodos('fila_atualizada', estadoAtual());
    processar();
    res.json({ success: true, posicao: fila.length });
});

app.post('/monitor/reordenar', autenticarBasic, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids inválido' });
    const mapa = new Map(fila.map(item => [item.id, item]));
    const nova = ids.map(id => mapa.get(id)).filter(Boolean);
    // Mantém itens que não vieram no payload (segurança)
    const restantes = fila.filter(item => !ids.includes(item.id));
    fila = [...nova, ...restantes];
    console.log(`🔀 Fila reordenada: [${ids.join(',')}]`);
    emitirParaTodos('fila_atualizada', estadoAtual());
    res.json({ success: true });
});

// ── START ──
app.listen(PORT, () => {
    console.log(`\n🚀 Gateway na porta ${PORT}`);
    console.log(`🖥️  Monitor: http://localhost:${PORT}/monitor`);
    console.log(`🏥 Health:  http://localhost:${PORT}/health\n`);
    ['EVOLUTION_URL','EVOLUTION_API_KEY','EVOLUTION_INSTANCE','GATEWAY_TOKEN','ADMIN_USER','ADMIN_PASSWORD']
        .filter(k => !process.env[k])
        .forEach(k => console.warn(`⚠️  ${k} não configurado`));
});

process.on('uncaughtException', err => console.error('💥', err));
process.on('unhandledRejection', reason => console.error('💥', reason));
