import { PrWebSocket } from '../../src/index.js'

const onMessage = (e) => {
  console.log('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;', `------->Breathe:e`, e)
}

const ws = new PrWebSocket({
  url: 'wss://toolin.cn/echo',
  onMessage(e) {
    console.log('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;', `------->Breathe:e`, e)
  },
  checkReconnect(e) {
    const a = Math.random() > 0.4
    console.log('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;', `------->Breathe:a`, a)
    return a
  }
})

ws.connect()

setInterval(() => {
  ws.close()
}, 1000)
