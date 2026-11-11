/*
账户会话：读取登录者、注册、登录与退出。调用：const account = useAccount(); await account.load()。
AJAX切页共享同一身份；认证代次与读取序号阻止旧回包恢复已退出或已切换的账号。
身份由HttpOnly会话确认；身份确认变化或明确401时清理页面数据，网络错误不当成退出。
*/
import type { User } from '~/types/api'; // 浏览器只保存必要身份字段

/** @returns 当前用户及登录会话操作。 */
export function useAccount() {
  // Nuxt state 在同一次浏览器会话共享
  const user = useState<User | null>('account', () => null); // 不持久化 cookie 之外的鉴权凭据
  const generation = useState('account-generation', () => 0); // 每个Nuxt实例独立，不在SSR模块全局共享
  const reading = useState('account-reading', () => 0); // 同一代也只采用最后一次身份读取
  const changing = useState('account-changing', () => false); // 登录与注销不并发改写同一浏览器cookie
  const app = useNuxtApp(); // await之后仍通过原应用实例清理缓存
  const router = useRouter(); // 注销必须直接发起导航，不被其它路由正在等待的中间件状态变成返回值
  const api = useApi(); // API 读取 HttpOnly 会话 cookie

  /** 清理会话所属页面数据；全部清理避免新增私有主体时遗漏一个缓存key。 */
  function clear() {
    user.value = null;
    app.runWithContext(() => clearNuxtData()); // 连同未完成的旧asyncData结果一起失效
  }

  /** @param expected 本次读取所属认证代次。@returns 最新已确认身份，过时读取不能回写。 */
  async function read(expected: number) {
    const sequence = ++reading.value; // 比较次序只在此应用内生效
    try {
      const found = await api<User>('/auth/me'); // 后端仍独立核验cookie与账号状态
      if (expected !== generation.value || sequence !== reading.value) return user.value; // 较早成功也不能覆盖较新的账号
      if (user.value?.id !== found.id) app.runWithContext(() => clearNuxtData()); // 换身份时不保留上一账号的页面结果
      user.value = found;
      return found; // 相同账号的正常读取仍可更新姓名和权限
    } catch (error) {
      if (expected !== generation.value || sequence !== reading.value) return user.value; // 旧401不能清掉新会话
      if ((error as { statusCode?: number }).statusCode === 401) {
        generation.value++; // 当前代已被服务器明确判为未登录，其它旧读取一并失效
        clear();
      }
      throw error; // 网络故障不伪装成退出，也不吞掉真实401
    }
  }

  /** @returns 当前登录者；认证提交中不以旧cookie另起身份请求。 */
  async function load() {
    if (changing.value) return user.value; // 保持现有界面，等登录或注销自己的确认结果
    return read(generation.value);
  }

  /** @returns 新认证代次；拒绝同时提交两个会改写会话cookie的动作。 */
  function begin() {
    if (changing.value) {
      const message = '登录状态正在更新，请稍后再试。';
      throw createError({ statusCode: 409, message, data: { message } }); // 与现有apiMessage错误出口保持一致
    }
    changing.value = true;
    return ++generation.value; // 先让此前的身份请求失效，失败时仍保留最后已知身份
  }
  /** @param email 登录邮箱。@param password 密码。 */
  async function login(
    email: string,
    password: string,
    proof: { totp?: string; recoveryCode?: string } = {},
  ) {
    const expected = begin();
    try {
      await api('/auth/login', { method: 'POST', body: { email: email.trim(), password, ...proof } });
      clear(); // 登录已确认改变会话；后续读取若断网也不能继续显示上一账号
      await read(expected); // 认证内部读取不受普通load的busy短路影响
    } finally {
      changing.value = false; // 错误密码或网络失败都允许用户再次提交
    }
  } // 登录后读取完整身份
  /** @param input 注册表单的姓名、邮箱与密码。@returns 注册后由服务器确认的新身份。 */
  async function register(input: { name: string; email: string; password: string; referralCode?: string }) {
    const expected = begin(); // 注册也会改写会话，不能与登录或注销交错提交
    try {
      await api('/auth/register', { method: 'POST', body: input });
      clear(); // 创建已获确认后不继续显示前一个账号或其页面缓存
      await read(expected); // 旧me回包不能覆盖刚注册的账号
    } finally {
      changing.value = false; // 字段错误或网络故障后允许修正并重试
    }
  }
  /** 手机/验证码登录与验证注册复用认证代次，旧回包不能覆盖刚确认的新身份。 */
  async function verified(action:'phone-login'|'verify-login'|'verify-register',body:Record<string,unknown>){
    const expected=begin();
    try{await api(`/auth/${action}`,{method:'POST',body});clear();await read(expected);}
    finally{changing.value=false;}
  }
  /** @returns 退出后回到首页。 */
  async function logout() {
    begin();
    try {
      try {
        await api('/auth/logout', { method: 'POST' }); // 收到成功或明确401前不在本地假装注销
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error; // 网络失败保留身份与当前路由
      }
      clear(); // 401也已经明确证明当前会话无效
      await router.push('/'); // 只在已确认退出后发起新导航，取代仍等待旧身份响应的路由
    } finally {
      changing.value = false; // 注销失败后可重试，旧load仍不能恢复旧身份
    }
  } // 服务端撤销后再清空界面
  return { user, load, register, login, verified, logout }; // 页面只通过这里操作会话
}
