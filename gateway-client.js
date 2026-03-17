// ============================================
// GATEWAY-CLIENT.JS
// Substitui chamadas diretas à Evolution API.
// Usado pelo quizback E pelo comunidade-backend.
// ============================================

const axios = require('axios');

const GATEWAY_URL = process.env.GATEWAY_URL;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

/**
 * Envia mensagem via gateway central.
 * @param {string}  telefone   Número formatado (ex: 5562998257978)
 * @param {string}  mensagem   Texto da mensagem
 * @param {string}  nome       Nome do destinatário (para exibição na fila)
 * @param {string}  origem     Identificador do sistema (ex: 'quizback', 'comunidade')
 * @param {boolean} imediato   true = pula a fila (pagamento acabou de ocorrer)
 */
async function enviarViаGateway(telefone, mensagem, nome, origem, imediato = false) {
    if (!GATEWAY_URL || !GATEWAY_TOKEN) {
        throw new Error('GATEWAY_URL ou GATEWAY_TOKEN não configurados');
    }

    try {
        const resp = await axios.post(
            `${GATEWAY_URL}/enviar`,
            { telefone, mensagem, nome, origem, imediato },
            {
                headers: {
                    'x-gateway-token': GATEWAY_TOKEN,
                    'Content-Type': 'application/json',
                },
                timeout: 10000,
            }
        );
        return resp.data; // { success, id, posicao, imediato }
    } catch (err) {
        const detalhe = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        throw new Error(`Gateway erro: ${detalhe}`);
    }
}

/**
 * Busca estado atual da fila.
 */
async function buscarFila() {
    const resp = await axios.get(`${GATEWAY_URL}/fila`, {
        headers: { 'x-gateway-token': GATEWAY_TOKEN },
        timeout: 5000,
    });
    return resp.data;
}

/**
 * Cancela uma mensagem da fila pelo ID.
 */
async function cancelarMensagem(id) {
    const resp = await axios.delete(`${GATEWAY_URL}/fila/${id}`, {
        headers: { 'x-gateway-token': GATEWAY_TOKEN },
        timeout: 5000,
    });
    return resp.data;
}

module.exports = { enviarViаGateway, buscarFila, cancelarMensagem };
