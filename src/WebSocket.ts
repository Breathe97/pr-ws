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
   * 发送消息前是否自动检查并连接
   */
  sendBeforAutoConnect?: boolean

  /**
   * 重连最大次数 默认-1 不限次数 0为不重连
   */
  reconnectCount?: number

  /**
   * 重连最大时间 ms 默认为-1 不限时间
   */
  reconnectTime?: number

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
   * 重连成功
   * @description 重连成功后执行该函数
   */
  onReconnectSuccess?: (e: WebSocket) => Promise<void>

  /**
   * 重连停止
   * @description 当重连次数耗尽或 checkReconnect 主动阻止时 不在继续重连时 触发该函数
   */
  onReconnectStop?: (e: WebSocket) => Promise<void>

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
    sendBeforAutoConnect: false,
    reconnectCount: -1,
    reconnectTime: 60 * 1000,
    reconnectIntervalTime: 5000,
    heartbeatIntervalTime: 10000,
    checkReconnect: (_e: any) => true,
    onReconnectSuccess: async (_e: any) => {},
    onReconnectStop: async (_e: any) => {},
    getHeartbeatMsg: () => JSON.stringify({ event: 'heartbeat' }) as string | ArrayBufferLike | Blob | ArrayBufferView,
    onMessage: (_e: any) => {}
  }

  #ws: WebSocket | undefined // 当前连接实例

  #surplusReconnectCount = -1 // 剩余重连次数
  #maxReconnectionTimeStamp = -1 // 最大重连时间戳

  #reconnectIntervalTimer: number = 0 // 重连间隔时间计时器
  #heartbeatIntervalTimer: number = 0 // 心跳间隔时间计时器

  #permanentClosed: boolean = false // 是否永久关闭 在主动调用close 之后为true 防止因网络原因导致 1006 继续重连

  #resolve = (_e: unknown) => {} // 初始化成功的回调

  constructor(_options: PrWebSocketOptions) {
    // 合并配置
    this.#options = { ...this.#options, ..._options }
    this.#surplusReconnectCount = this.#options.reconnectCount
  }

  /**
   * 关闭
   */
  close = async (code: number = 1000, reason: string = 'correctly close.') => {
    if (this.#ws) {
      this.#permanentClosed = true
      this.#clear()
      this.#ws?.close(code, reason)
    }
  }

  /**
   * 连接
   */
  connect = () => {
    return new Promise(async (resolve) => {
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
   * 重新连接
   * @param e
   * @returns ws
   */
  reconnect = async (e?: Event | CloseEvent) => {
    return new Promise((resolve, reject) => {
      if (this.#options.debug) {
        console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: await reconnect.`)
      }

      // 停止重连
      const onReconnectStop = (msg: string) => {
        if (this.#options.debug) {
          console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: ${msg}`)
        }
        this.#options.onReconnectStop({ msg })
        return reject(msg)
      }

      // 停止重连 重连超时
      if (this.#checkReconnectionTime() === false) return onReconnectStop('stop reconnect. exceed maxReconnectionTime.')

      // 停止重连 没有重连次数
      if (this.#surplusReconnectCount !== -1 && this.#surplusReconnectCount === 0) return onReconnectStop('stop reconnect. surplusReconnectCount is 0.')

      // 停止重连 是否主动判断
      if (!this.#options.checkReconnect(e)) return onReconnectStop('stop reconnect. checkReconnect is false.')

      if (this.#options.debug) {
        console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: await ${this.#options.reconnectIntervalTime}ms run reconnect. surplusReconnectCount is ${this.#surplusReconnectCount}`, e)
      }

      // 即将重连
      this.#reconnectIntervalTimer = setTimeout(async () => {
        this.#surplusReconnectCount = Math.max(-1, this.#surplusReconnectCount - 1)
        await this.connect()
        try {
          await this.#options.onReconnectSuccess(this.#ws)
        } catch (error) {
          console.error('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;', `------->pr-ws: onReconnectSuccess is error`, error)
        }
        resolve(true)
      }, this.#options.reconnectIntervalTime)
    })
  }

  /**
   * 发送消息
   */
  sendMessage = async (_data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    // 当 ws 异常的时候尝试进行重连
    if (!this.#ws || this.#ws.readyState !== 1) {
      if (this.#options.debug) {
        console.warn('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: ws is not ready.`)
      }
      if (this.#options.sendBeforAutoConnect) {
        if (this.#options.debug) {
          console.warn('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: await ws connect.`)
        }
        await this.connect()
      }
    }
    // 发送消息
    this.#ws?.send(_data)
  }

  // 检查最大重连时间
  #checkReconnectionTime = () => {
    const now = Date.now()
    // 第一次重连记录最大时间
    if (this.#maxReconnectionTimeStamp === -1) {
      this.#maxReconnectionTimeStamp = now + this.#options.reconnectTime
    }
    // 比较当前时间是否已经超出最大时间
    if (now > this.#maxReconnectionTimeStamp) return false // 不能再次重连
    return true // 还阔以重连
  }

  // 服务端消息回调
  #onMessage = (e: MessageEvent) => {
    const { data } = e
    this.#options.onMessage(data)
  }

  // 连接成功
  #onOpen = () => {
    if (this.#options.debug) {
      console.log('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: connect is success.`, this.#ws)
    }
    this.#surplusReconnectCount = this.#options.reconnectCount // 连接成功 重置重连次数
    this.#maxReconnectionTimeStamp = -1
    this.#initHeartbeat() // 开启心跳

    this.#resolve(this.#ws)
  }

  // 连接错误
  #onError = (e: Event) => {
    if (this.#options.debug) {
      console.error('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: connect is error.`, e)
    }
  }

  // 连接关闭
  #onClose = (e: CloseEvent) => {
    if (this.#options.debug) {
      console.info('\x1b[38;2;0;151;255m%c%s\x1b[0m', 'color:#0097ff;padding:16px 0;', `------->pr-ws: connect is close. code: ${e.code}, permanentClosed is ${this.#permanentClosed}.`, e)
    }

    this.#clear() // 只要关闭都清理当前实列

    // 非主动关闭 并且 非正常关闭
    if (!this.#permanentClosed && e.code !== 1000) {
      return this.reconnect(e)
    }
    this.#ws = undefined
  }

  // 心跳
  #initHeartbeat = () => {
    this.#heartbeatIntervalTimer = setInterval(() => {
      const message = this.#options.getHeartbeatMsg()
      if (message) {
        this.sendMessage(message)
      }
    }, this.#options.heartbeatIntervalTime)
  }

  // 清理
  #clear = () => {
    clearInterval(this.#reconnectIntervalTimer)
    clearInterval(this.#heartbeatIntervalTimer)
  }
}
