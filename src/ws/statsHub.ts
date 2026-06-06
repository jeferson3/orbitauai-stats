import { IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { WsServerMessage } from '../types/contracts.js'

export class StatsHub {
  private wss = new WebSocketServer({ noServer: true })
  private clients = new Set<WebSocket>()

  constructor() {
    this.wss.on('connection', (socket) => {
      this.clients.add(socket)

      socket.on('close', () => {
        this.clients.delete(socket)
      })
    })
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request)
    })
  }

  broadcast(payload: WsServerMessage): void {
    const data = JSON.stringify(payload)

    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data)
      }
    }
  }
}
