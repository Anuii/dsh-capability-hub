/**
 * 网络访问的公共类型（0.10.0，D-B19）：宿主与界面都用，只有类型、不知道任何功能。
 *
 * 背景：使用者要求「镜像存在时，网络问题应当无感」——直连失败自动退镜像、都没有时用缓存并标注，
 * 而不是把网络错误直接摆到界面上。
 */

/** 一条请求实际走的路：直连，或经 GitHub 镜像（镜像请求永不携带令牌）。 */
export type NetworkRoute = "direct" | "mirror";

/** 镜像能力探测结果：同一个镜像对「下载类地址」与「api.github.com」的支持并不一致。 */
export interface MirrorCapabilities {
  /** 是否配置了镜像（未配置时其余字段无意义） */
  configured: boolean;
  /** 下载类地址是否可用（raw.githubusercontent.com / github.com 的 archive 形式） */
  downloads?: boolean;
  /** api.github.com 是否可用（无令牌探测：部分镜像会代 API，部分直接 403） */
  api?: boolean;
  /** 探测时刻（ISO） */
  probedAt?: string;
  /** 整条镜像不可用时的中文原因 */
  error?: string;
}

/** 直连状态（设置页显示「可用 / 403 / 超时」）。 */
export interface DirectStatus {
  ok: boolean;
  /** HTTP 状态码；网络层失败（超时 / DNS / 连接被拒）时没有 */
  status?: number;
  /** 失败时的中文原因 */
  message?: string;
  /** 探测时刻（ISO） */
  checkedAt: string;
}

/** 一块数据是怎么来的：刚刚联网取的（直连或镜像），还是来自缓存。 */
export interface DataProvenance {
  route: NetworkRoute | "cache";
  /** 取到数据的时刻；route = "cache" 时是写入缓存的时刻（ISO） */
  at: string;
  /** 经镜像时的镜像主机名（界面展示用，例如 ghfast.top） */
  mirrorHost?: string;
}
