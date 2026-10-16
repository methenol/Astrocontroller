import net from 'node:net';

/**
 * A minimal FTP server for the transfer tests: anonymous login, extended passive mode, LIST and
 * RETR over an in-memory tree. `truncate` cuts a file's data short (the data connection closes
 * early and the transfer still ends with 226), the way a dropped Wi-Fi link can look to a client.
 */
export class FakeFtp {
  /** remote path ("/Astronomy/X/a.fits") → contents */
  readonly files = new Map<string, Buffer>();
  /** remote path → how many of the next RETRs of it send only half the data */
  readonly truncate = new Map<string, number>();
  readonly retrs: string[] = [];
  /** how long the login (PASS) takes to be answered */
  loginDelayMs = 0;
  private server = net.createServer((s) => this.session(s));
  private sockets = new Set<net.Socket>();
  port = 0;

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private session(ctrl: net.Socket): void {
    this.sockets.add(ctrl);
    ctrl.on('close', () => this.sockets.delete(ctrl));
    ctrl.on('error', () => undefined);
    const say = (line: string) => ctrl.write(`${line}\r\n`);
    let passive: { server: net.Server; conn: Promise<net.Socket> } | null = null;
    let buf = '';
    say('220 fake DWARF FTP');

    const openPassive = async (): Promise<number> => {
      passive?.server.close();
      const server = net.createServer();
      const conn = new Promise<net.Socket>((resolve) => server.once('connection', (s) => {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => undefined);
        resolve(s);
      }));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      passive = { server, conn };
      return (server.address() as net.AddressInfo).port;
    };

    const sendData = async (data: Buffer) => {
      const p = passive;
      passive = null;
      if (!p) {
        say('425 no data connection');
        return;
      }
      say('150 opening data connection');
      const sock = await p.conn;
      await new Promise<void>((r) => sock.end(data, () => r()));
      p.server.close();
      say('226 transfer complete');
    };

    const dirOf = (arg: string) => (arg.replace(/^-\S+\s*/, '').trim() || '/').replace(/\/+$/, '') || '/';

    const handle = async (line: string): Promise<unknown> => {
      const sp = line.indexOf(' ');
      const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : line.slice(sp + 1);
      switch (cmd) {
        case 'USER':
          return say('331 password please');
        case 'PASS':
          if (this.loginDelayMs) await new Promise((r) => setTimeout(r, this.loginDelayMs));
          return say('230 logged in');
        case 'FEAT':
          return say('211 no features');
        case 'TYPE':
        case 'STRU':
        case 'OPTS':
          return say('200 ok');
        case 'PWD':
          return say('257 "/"');
        case 'EPSV':
          return say(`229 Entering Extended Passive Mode (|||${await openPassive()}|)`);
        case 'LIST': {
          const dir = dirOf(arg);
          const prefix = dir === '/' ? '/' : `${dir}/`;
          const rows = [...this.files].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
            .map(([p, b]) => `-rw-r--r-- 1 root root ${b.length} Oct 12 21:00 ${p.slice(prefix.length)}`);
          return sendData(Buffer.from(rows.map((r) => `${r}\r\n`).join('')));
        }
        case 'RETR': {
          const f = this.files.get(arg);
          if (!f) {
            passive?.server.close();
            passive = null;
            return say('550 no such file');
          }
          this.retrs.push(arg);
          const cut = this.truncate.get(arg) ?? 0;
          if (cut > 0) this.truncate.set(arg, cut - 1);
          return sendData(cut > 0 ? f.subarray(0, Math.floor(f.length / 2)) : f);
        }
        case 'QUIT':
          say('221 bye');
          return void ctrl.end();
        default:
          return say('502 not implemented');
      }
    };

    // commands are answered strictly in order
    let chain = Promise.resolve();
    ctrl.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        chain = chain.then(() => handle(line)).then(() => undefined, () => undefined);
      }
    });
  }
}
