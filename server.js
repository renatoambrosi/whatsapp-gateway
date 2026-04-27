async function processar() {
    if (processando) return;
    if (!fila.length) return;

    processando = true;
    emitirParaTodos('fila_atualizada', estadoAtual());

    while (fila.length > 0) {

        while (pausado) {
            await sleep(2000);
        }

        const item = fila.shift();
        emitirParaTodos('fila_atualizada', estadoAtual());

        if (!item.imediato) {
            const agora = Date.now();
            const espera = cooldownMs - (agora - ultimoEnvio);
            if (espera > 0 && ultimoEnvio > 0) {
                emitirParaTodos('aguardando', { segundos: Math.ceil(espera / 1000), proximo: item.nome });
                await sleep(espera);
            }
        }

        while (pausado) {
            await sleep(2000);
        }

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
