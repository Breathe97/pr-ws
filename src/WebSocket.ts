export interface PrWebSocketOptions {
  /**
   * 连接地址
   */
  url: string

  /**
   * 数据传输类型
   */
  binaryType?: BinaryType

  /**
   * 超时时间
   */
  timeout?: number

  /**
   * 开启后会在控制台显示相关操作日志 默认为false
   */
  debug?: boolean

  /**
   * 重连最大次数 默认-1 不限次数 0为不重连
   */
  reconnectCount?: number

  /**
   * 重连间隔时间 ms
   */
  reconnectIntervalTime?: number

  /**
   * 心跳间隔时间 ms
   */
  heartbeatIntervalTime?: number

  /**
   * 是否重连
   * @description 返回true时立即重连 返回false 不重连 并销毁 WebSocket
   */
  checkReconnect?: (e: Event | CloseEvent) => boolean

  /**
   * 自定义心跳事件
   * @description 将函数的返回值作为每次心跳的message
   */
  getHeartbeatMsg?: () => string | ArrayBufferLike | Blob | ArrayBufferView

  /**
   * 消息回调
   * @description 当前 WebSocket 的所有消息
   */
  onMessage?: (e: any) => void
}

export class PrWebSocket {
  #options = {
    url: '',
    binaryType: 'blob' as BinaryType,
    timeout: 6 * 1000,
    debug: false,
    reconnectCount: -1,
    reconnectIntervalTime: 3000,
    heartbeatIntervalTime: 10000,
    checkReconnect: (_e: any) => true,
    getHeartbeatMsg: () => JSON.stringify({ event: 'heartbeat' }) as string | ArrayBufferLike | Blob | ArrayBufferView,
    onMessage: (_e: any) => {}
  }

  #ws: WebSocket | undefined // 当前连接实例

  #surplusReconnectCount = -1 // 剩余重连次数
  #reconnectIntervalTimer: number = 0 // 重连间隔时间计时器
  #heartbeatIntervalTimer: number = 0 // 心跳间隔时间计时器

  #resolve = (_e: unknown) => {} // 初始化成功的回调

  constructor(_options: PrWebSocketOptions) {
    // 合并配置
    this.#options = { ...this.#options, ..._options }
    this.#surplusReconnectCount = this.#options.reconnectCount
  }

  /**
   * 关闭
   */
  close = (code: number = 1000, reason: string = '主动关闭') => {
    clearInterval(this.#reconnectIntervalTimer)
    clearInterval(this.#heartbeatIntervalTimer)
    this.#ws?.close(code, reason)
  }

  /**
   * 连接
   */
  connect = () => {
    return new Promise((resolve) => {
      if (this.#ws && this.#ws.readyState === 1) return resolve(this.#ws)
      this.close() // 尝试关闭可能存在的链接
      this.#resolve = resolve
      this.#ws = new WebSocket(this.#options.url)
      this.#ws.binaryType = this.#options.binaryType

      // 指定回调事件
      this.#ws.onopen = this.#onOpen
      this.#ws.onmessage = this.#onMessage
      this.#ws.onerror = this.#onError
      this.#ws.onclose = this.#onClose
    })
  }

  /**
   * 发送消息
   */
  sendMessage = async (_data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    if (!this.#ws || this.#ws.readyState !== 1) {
      if (this.#options.debug) {
        console.error('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: ws is error. await connect.`, this.#ws)
      }
      await this.connect()
    }
    // 发送消息
    this.#ws!.send(_data)
  }

  // 服务端消息回调
  #onMessage = (e: MessageEvent) => {
    const { data } = e
    this.#options.onMessage(data)
  }

  // 连接成功
  #onOpen = () => {
    if (this.#options.debug) {
      console.log('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: connect is success.`, this.#options)
    }
    this.#surplusReconnectCount = this.#options.reconnectCount // 连接成功 重置重连次数
    this.#initHeartbeat() // 开启心跳
    this.#resolve(this.#ws)
  }

  // 连接错误
  #onError = (e: Event) => {
    if (this.#options.debug) {
      console.error('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: connect is error.`, e)
    }
    this.#reconnect(e)
  }

  // 连接关闭
  #onClose = (e: CloseEvent) => {
    if (this.#options.debug) {
      console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: connect is close.`, e)
    }
    if (e.code === 1000) {
      this.#ws = undefined
      return
    }
    this.#reconnect(e)
  }

  // 心跳
  #initHeartbeat = () => {
    if (this.#heartbeatIntervalTimer) {
      clearInterval(this.#heartbeatIntervalTimer)
    }
    this.#heartbeatIntervalTimer = setInterval(() => {
      const message = this.#options.getHeartbeatMsg()
      if (message) {
        this.sendMessage(message)
      }
    }, this.#options.heartbeatIntervalTime)
  }

  // 重新连接
  #reconnect = (e: Event | CloseEvent) => {
    // 没有重连机会
    if (this.#surplusReconnectCount !== -1 && this.#surplusReconnectCount === 0) {
      if (this.#options.debug) {
        console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: surplusReconnectCount is 0.`)
      }
      return
    }

    const isReconnect = this.#options.checkReconnect(e) // 判断是否重连

    // 被阻止重连
    if (!isReconnect) {
      if (this.#options.debug) {
        console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: checkReconnect is false.`)
      }
      return // 禁止重连
    }
    if (this.#options.debug) {
      console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: await reconnect.`, e)
    }

    // 即将重连
    const func = async () => {
      await this.connect()
      this.#surplusReconnectCount = Math.max(-1, this.#surplusReconnectCount - 1)
    }

    this.#reconnectIntervalTimer = setTimeout(func, this.#options.reconnectIntervalTime)
  }
}
