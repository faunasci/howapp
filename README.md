# HowApp

Aplicativo de comunicação ponto a ponto (P2P) que roda inteiramente no browser — sem servidor, sem cadastro, sem instalação.

Suporta texto, áudio, vídeo, compartilhamento de tela, imagens e arquivos em tempo real.

---

## Como funciona

O HowApp usa **WebRTC** para estabelecer conexões diretas entre os participantes. A sinalização (troca de endereços para iniciar a conexão) é feita via **PeerJS**, que usa os servidores públicos do PeerJS apenas para o "aperto de mão" inicial. Depois disso, os dados trafegam diretamente entre os browsers, sem passar por nenhum servidor intermediário.

**Arquitetura da sala:**
- O primeiro participante a criar a sala vira o **anfitrião** e funciona como hub de retransmissão de mensagens.
- Os demais participantes conectam-se ao anfitrião, que repassa as mensagens para todos.
- As chamadas de vídeo/áudio e o compartilhamento de tela são P2P direto entre os pares (sem relay).
- Se o anfitrião sair, o sistema tenta promover outro participante automaticamente.

---

## Uso

### Abrir o app

Abra o arquivo `index.html` diretamente no browser. Não é necessário servidor web — funciona como arquivo local (`file://`).

> Para usar entre dispositivos diferentes na mesma rede ou via internet, sirva o arquivo com um servidor HTTP simples (ver seção [Expor na rede](#expor-na-rede)).

---

### Criar uma sala

1. Digite seu **nome** no campo "Seu nome".
2. Clique em **Criar Nova Sala**.
3. A sala é criada e você entra como anfitrião.
4. Compartilhe o link gerado na barra superior com quem quiser convidar.

---

### Entrar em uma sala existente

1. Digite seu **nome** no campo "Seu nome".
2. Cole o **link completo** ou só o **ID da sala** no campo "ID da sala ou link completo".
3. Clique em **Entrar na Sala**.

O ID de sala é uma sequência curta de letras e números (ex: `AB3K9XZW`). O link completo tem o formato:

```
https://seudominio.com/index.html?room=ab3k9xzw
```

---

### Convidar alguém pelo nome

Dentro da sala, use a barra **Convidar**:

1. Digite o nome do convidado no campo "Nome do convidado".
2. Clique em **Gerar Link** (ou pressione Enter).
3. Um link personalizado é gerado e copiado automaticamente para o clipboard.
4. Envie o link para o convidado — ao abri-lo, o campo de nome já vem preenchido com o nome dele.

---

### Chat de texto

- Digite a mensagem na caixa de texto e pressione **Enter** (ou clique no botão enviar ►).
- **Shift+Enter** para nova linha sem enviar.
- Use o botão **😊** para abrir o seletor de emojis.
- Arraste e solte imagens diretamente na área de mensagens para enviá-las.

---

### Chamada de áudio / vídeo

| Botão | Ação |
|-------|------|
| 📞 | Iniciar chamada de **áudio** |
| 📹 | Iniciar chamada de **vídeo** |
| 🎤 | Mutar / desmutar microfone (durante chamada) |
| 📷 | Ligar / desligar câmera (durante chamada de vídeo) |
| ⏹️ | Encerrar a chamada |

> Ao clicar em 📞 ou 📹, o browser pedirá permissão para acessar o microfone e/ou a câmera.

---

### Compartilhamento de tela

1. Durante uma chamada (ou mesmo sem ela), clique em **🖥️**.
2. O browser abre o seletor de janela/aba/tela inteira.
3. Escolha o que deseja compartilhar e confirme.
4. Todos na sala verão sua tela em tempo real.
5. Para parar, clique novamente em **🖥️** ou use o botão "Parar compartilhamento" do próprio browser.

---

### Envio de imagens e arquivos

- Clique em **📷** para selecionar uma imagem (jpg, png, gif, etc.).
- Clique em **📎** para selecionar qualquer outro tipo de arquivo.
- O destinatário verá a imagem diretamente no chat, ou um link para baixar o arquivo.

> Arquivos trafegam codificados em base64 pelo canal de dados P2P. Para arquivos grandes, o envio pode ser lento.

---

### Mensagem de voz

1. Clique em **🎙️** para começar a gravar.
2. Clique novamente para parar e enviar automaticamente.
3. O destinatário clica na mensagem de áudio para ouvir.

---

### Sair da sala

Clique em **🚪** no canto superior direito, ou no botão **←** para voltar à tela inicial.

---

## Expor na rede

O app é um único arquivo HTML estático. Para acessá-lo de outros dispositivos ou da internet, você precisa de um servidor HTTP.

### Opção 1 — Servidor local simples

```bash
# Python 3
python3 -m http.server 8080

# Node.js (npx)
npx serve .
```

Acesse de outros dispositivos na mesma rede Wi-Fi pelo IP local:
```
http://192.168.x.x:8080/index.html
```

### Opção 2 — Túnel para a internet (sem configurar roteador)

**Cloudflare Tunnel (grátis, sem conta):**
```bash
cloudflared tunnel --url http://localhost:8080
```

**ngrok:**
```bash
ngrok http 8080
```

**localtunnel:**
```bash
npx localtunnel --port 8080
```

Qualquer um destes gera uma URL pública temporária (ex: `https://abc123.trycloudflare.com`) que você pode compartilhar.

### Opção 3 — Hospedagem estática permanente (grátis)

Como é um único arquivo HTML, pode ser publicado em qualquer serviço de hospedagem estática:

| Serviço | Como publicar |
|---------|--------------|
| **Netlify Drop** | Acesse [app.netlify.com/drop](https://app.netlify.com/drop) e arraste a pasta |
| **GitHub Pages** | Suba para um repositório público e ative Pages nas configurações |
| **Vercel** | `npx vercel` na pasta do projeto |

---

## Requisitos

- Browser moderno com suporte a WebRTC: Chrome 80+, Firefox 75+, Edge 80+, Safari 14+.
- Microfone e/ou câmera para chamadas de áudio/vídeo (opcional).
- Conexão com a internet para o handshake inicial via PeerJS (após isso, a comunicação pode ser local).

> Em redes corporativas com firewalls restritivos, a conexão P2P pode falhar. O app inclui servidores TURN como fallback para esses casos.

---

## Privacidade

- Nenhum dado é armazenado em servidor.
- Mensagens, arquivos e streams de vídeo trafegam diretamente entre os participantes.
- O servidor PeerJS é usado **apenas** para o handshake inicial (troca de endereços IP). Ele não vê o conteúdo das mensagens.
- Ao fechar a aba, todos os dados da sessão são descartados.

---

## Limitações conhecidas

- **Sem histórico persistente** — mensagens são perdidas ao fechar a aba.
- **Sem criptografia de ponta a ponta explícita** — a conexão WebRTC é criptografada por padrão pelo protocolo DTLS, mas não há verificação de identidade dos participantes.
- **Arquivos grandes** — o envio é feito em base64 pelo canal de dados; arquivos acima de ~5 MB podem ser lentos ou falhar.
- **Promoção de anfitrião** — se o anfitrião original sair, a promoção automática é limitada (novos entrantes podem não conseguir conectar até alguém recriar a sala com o mesmo ID).
