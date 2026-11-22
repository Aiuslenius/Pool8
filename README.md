# 8-Ball Pool – egen server

Ingen installation av paket behövs, bara Node.js (version 16 eller nyare, nodejs.org).

## Kör på din dator
1. Packa upp mappen och öppna en terminal i den.
2. Kör: `node server.js`
3. Öppna adressen som skrivs ut. Vän på samma wifi använder raden "(samma wifi)".
4. Båda väljer **Spela online**. En skapar rum, den andra går med med koden.

## Vän på annat nätverk (utan hosting)
Kör servern och starta en tunnel i en andra terminal:
- Cloudflare: `cloudflared tunnel --url http://localhost:3000`
- eller ngrok: `ngrok http 3000`
Skicka den https-adress du får till din vän.

## Permanent adress (gratis hosting, t.ex. Render)
1. Lägg mappen i ett GitHub-repo.
2. På render.com: New → Web Service → välj repot.
3. Build command: (tom). Start command: `node server.js`.
4. Använd adressen du får. Servern lyssnar på miljövariabeln PORT automatiskt.
(Gratisnivån somnar efter inaktivitet, så första laddningen kan ta en halv minut.)

## Filer
- `server.js` – webbserver + WebSocket-relä (inga beroenden)
- `public/index.html` – spelet
- `adapter.js` – referenskopia av anslutningskoden som redan ligger inbäddad i index.html
