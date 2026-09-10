/** zmodem.js 0.1.10 的 API 形状声明（该库无类型定义，按源码确认） */
declare module 'zmodem.js' {
  interface ZmodemDetection {
    /** 确认检测到的 ZMODEM 会话，返回 Session（Send 或 Receive 实例） */
    confirm(): any
    deny(): void
    is_valid(): boolean
    /** 'receive' = 对端要发文件给我们（sz）；'send' = 对端等待接收（rz） */
    get_session_role(): 'receive' | 'send'
  }

  interface ZmodemSentryOptions {
    /** 非协议数据（正常终端输出）出口，octets 为八位字节数组 */
    to_terminal(octets: number[]): void
    /** 发往对端（SSH 会话）的出口 */
    sender(octets: number[]): void
    on_retract(): void
    on_detect(detection: ZmodemDetection): void
  }

  const Zmodem: {
    Sentry: new (opts: ZmodemSentryOptions) => {
      consume(input: Uint8Array | number[] | ArrayBuffer): void
      get_confirmed_session(): any
    }
    Session: {
      Receive: new () => any
      Send: new (hdr: any) => any
      parse: (input: number[]) => any
    }
    DEBUG: boolean
    [key: string]: any
  }

  export default Zmodem
}
