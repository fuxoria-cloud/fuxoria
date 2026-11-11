/* 国家与地区：保留原版国家、中文名称和电话区号，为资料表单提供可选择的选项。
 * 调用：GET /api/v1/country?q=中国；数据来自固定版本原项目安装SQL，标识CHINA规范为CN。
 */
import { Controller,Get,Header,Query } from '@nestjs/common';       // 公共查询不涉及客户私有资料
import { z } from 'zod';                                          // 搜索词只在边界整理
import { Public } from '../utils/access.js';                       // 注册或填资料前也能查询
import { read } from '../utils/input.js';                          // 保持一致的输入错误反馈

@Controller('country') @Public()
export default class Country {
  /** @param query 可选国家、地区或电话区号。@returns 对应的公开选项。 */
  @Header('Cache-Control','public, max-age=86400, s-maxage=604800') @Get() list(@Query('q') query:unknown) {
    const text=read(z.string().trim().max(100).default(''),query).toLowerCase(); // 空搜索返回全部选项
    return countries.filter(item=>`${item.code} ${item.name} ${item.phoneCode}`.toLowerCase().includes(text)); // 只筛选现成事实，不拼接SQL
  }
}

// --- 原版公开地区数据，中文名称与电话区号一起保管 ---
const countries: {code:string;name:string;phoneCode:string}[] = [
  {
    "code": "AF",
    "name": "阿富汗",
    "phoneCode": "93"
  },
  {
    "code": "AL",
    "name": "阿尔巴尼亚",
    "phoneCode": "355"
  },
  {
    "code": "DZ",
    "name": "阿尔及利亚",
    "phoneCode": "213"
  },
  {
    "code": "AS",
    "name": "美属萨摩亚",
    "phoneCode": "1684"
  },
  {
    "code": "AD",
    "name": "安道尔",
    "phoneCode": "376"
  },
  {
    "code": "AO",
    "name": "安哥拉",
    "phoneCode": "244"
  },
  {
    "code": "AI",
    "name": "安圭拉岛",
    "phoneCode": "1264"
  },
  {
    "code": "AQ",
    "name": "南极洲",
    "phoneCode": "0"
  },
  {
    "code": "AG",
    "name": "安提瓜岛和巴布达",
    "phoneCode": "1268"
  },
  {
    "code": "AR",
    "name": "阿根廷",
    "phoneCode": "54"
  },
  {
    "code": "AM",
    "name": "亚美尼亚",
    "phoneCode": "374"
  },
  {
    "code": "AW",
    "name": "阿鲁巴岛",
    "phoneCode": "297"
  },
  {
    "code": "AU",
    "name": "澳大利亚",
    "phoneCode": "61"
  },
  {
    "code": "AT",
    "name": "奥地利",
    "phoneCode": "43"
  },
  {
    "code": "AZ",
    "name": "阿塞拜疆",
    "phoneCode": "994"
  },
  {
    "code": "BS",
    "name": "巴哈马群岛",
    "phoneCode": "1242"
  },
  {
    "code": "BH",
    "name": "巴林",
    "phoneCode": "973"
  },
  {
    "code": "BD",
    "name": "孟加拉国",
    "phoneCode": "880"
  },
  {
    "code": "BB",
    "name": "巴巴多斯",
    "phoneCode": "1246"
  },
  {
    "code": "BY",
    "name": "白俄罗斯",
    "phoneCode": "375"
  },
  {
    "code": "BE",
    "name": "比利时",
    "phoneCode": "32"
  },
  {
    "code": "BZ",
    "name": "伯利兹",
    "phoneCode": "501"
  },
  {
    "code": "BJ",
    "name": "贝宁",
    "phoneCode": "229"
  },
  {
    "code": "BM",
    "name": "百慕大",
    "phoneCode": "1441"
  },
  {
    "code": "BT",
    "name": "不丹",
    "phoneCode": "975"
  },
  {
    "code": "BO",
    "name": "玻利维亚",
    "phoneCode": "591"
  },
  {
    "code": "BA",
    "name": "波斯尼亚和黑塞哥维那",
    "phoneCode": "387"
  },
  {
    "code": "BW",
    "name": "博茨瓦纳",
    "phoneCode": "267"
  },
  {
    "code": "BV",
    "name": "布维岛",
    "phoneCode": "0"
  },
  {
    "code": "BR",
    "name": "巴西",
    "phoneCode": "55"
  },
  {
    "code": "IO",
    "name": "英属印度洋领地",
    "phoneCode": "246"
  },
  {
    "code": "BN",
    "name": "文莱达鲁萨兰国",
    "phoneCode": "673"
  },
  {
    "code": "BG",
    "name": "保加利亚",
    "phoneCode": "359"
  },
  {
    "code": "BF",
    "name": "布吉纳法索",
    "phoneCode": "226"
  },
  {
    "code": "BI",
    "name": "布隆迪",
    "phoneCode": "257"
  },
  {
    "code": "KH",
    "name": "柬埔寨",
    "phoneCode": "855"
  },
  {
    "code": "CM",
    "name": "喀麦隆",
    "phoneCode": "237"
  },
  {
    "code": "CA",
    "name": "加拿大",
    "phoneCode": "1"
  },
  {
    "code": "CV",
    "name": "佛得角",
    "phoneCode": "238"
  },
  {
    "code": "KY",
    "name": "开曼群岛",
    "phoneCode": "1345"
  },
  {
    "code": "CF",
    "name": "中非共和国",
    "phoneCode": "236"
  },
  {
    "code": "TD",
    "name": "乍得",
    "phoneCode": "235"
  },
  {
    "code": "CL",
    "name": "智利",
    "phoneCode": "56"
  },
  {
    "code": "CN",
    "name": "中国",
    "phoneCode": "86"
  },
  {
    "code": "CX",
    "name": "圣诞岛",
    "phoneCode": "61"
  },
  {
    "code": "CC",
    "name": "COCOS(KEELING)岛",
    "phoneCode": "672"
  },
  {
    "code": "CO",
    "name": "哥伦比亚",
    "phoneCode": "57"
  },
  {
    "code": "KM",
    "name": "科摩罗",
    "phoneCode": "269"
  },
  {
    "code": "CG",
    "name": "刚果",
    "phoneCode": "242"
  },
  {
    "code": "CD",
    "name": "刚果民主共和国的",
    "phoneCode": "242"
  },
  {
    "code": "CK",
    "name": "库克群岛",
    "phoneCode": "682"
  },
  {
    "code": "CR",
    "name": "哥斯达黎加",
    "phoneCode": "506"
  },
  {
    "code": "CI",
    "name": "科特迪瓦",
    "phoneCode": "225"
  },
  {
    "code": "HR",
    "name": "克罗地亚",
    "phoneCode": "385"
  },
  {
    "code": "CU",
    "name": "古巴",
    "phoneCode": "53"
  },
  {
    "code": "CY",
    "name": "塞浦路斯",
    "phoneCode": "357"
  },
  {
    "code": "CZ",
    "name": "捷克共和国",
    "phoneCode": "420"
  },
  {
    "code": "DK",
    "name": "丹麦",
    "phoneCode": "45"
  },
  {
    "code": "DJ",
    "name": "吉布提",
    "phoneCode": "253"
  },
  {
    "code": "DM",
    "name": "多米尼加",
    "phoneCode": "1767"
  },
  {
    "code": "DO",
    "name": "多米尼加共和国",
    "phoneCode": "1809"
  },
  {
    "code": "EC",
    "name": "厄瓜多尔",
    "phoneCode": "593"
  },
  {
    "code": "EG",
    "name": "埃及",
    "phoneCode": "20"
  },
  {
    "code": "SV",
    "name": "萨尔瓦多",
    "phoneCode": "503"
  },
  {
    "code": "GQ",
    "name": "赤道几内亚",
    "phoneCode": "240"
  },
  {
    "code": "ER",
    "name": "厄立特里亚",
    "phoneCode": "291"
  },
  {
    "code": "EE",
    "name": "爱沙尼亚",
    "phoneCode": "372"
  },
  {
    "code": "ET",
    "name": "埃塞俄比亚",
    "phoneCode": "251"
  },
  {
    "code": "FK",
    "name": "福克兰群岛(马尔维纳斯)",
    "phoneCode": "500"
  },
  {
    "code": "FO",
    "name": "法罗群岛",
    "phoneCode": "298"
  },
  {
    "code": "FJ",
    "name": "斐济",
    "phoneCode": "679"
  },
  {
    "code": "FI",
    "name": "芬兰",
    "phoneCode": "358"
  },
  {
    "code": "FR",
    "name": "法国",
    "phoneCode": "33"
  },
  {
    "code": "GF",
    "name": "法属圭亚那",
    "phoneCode": "594"
  },
  {
    "code": "PF",
    "name": "法属波利尼西亚",
    "phoneCode": "689"
  },
  {
    "code": "TF",
    "name": "法国南部地区",
    "phoneCode": "0"
  },
  {
    "code": "GA",
    "name": "加蓬",
    "phoneCode": "241"
  },
  {
    "code": "GM",
    "name": "冈比亚",
    "phoneCode": "220"
  },
  {
    "code": "GE",
    "name": "乔治亚州",
    "phoneCode": "995"
  },
  {
    "code": "DE",
    "name": "德国",
    "phoneCode": "49"
  },
  {
    "code": "GH",
    "name": "加纳",
    "phoneCode": "233"
  },
  {
    "code": "GI",
    "name": "直布罗陀",
    "phoneCode": "350"
  },
  {
    "code": "GR",
    "name": "希腊",
    "phoneCode": "30"
  },
  {
    "code": "GL",
    "name": "格陵兰岛",
    "phoneCode": "299"
  },
  {
    "code": "GD",
    "name": "格林纳达",
    "phoneCode": "1473"
  },
  {
    "code": "GP",
    "name": "瓜德罗普岛",
    "phoneCode": "590"
  },
  {
    "code": "GU",
    "name": "关岛",
    "phoneCode": "1671"
  },
  {
    "code": "GT",
    "name": "危地马拉",
    "phoneCode": "502"
  },
  {
    "code": "GN",
    "name": "几内亚",
    "phoneCode": "224"
  },
  {
    "code": "GW",
    "name": "几内亚比绍",
    "phoneCode": "245"
  },
  {
    "code": "GY",
    "name": "圭亚那",
    "phoneCode": "592"
  },
  {
    "code": "HT",
    "name": "海地",
    "phoneCode": "509"
  },
  {
    "code": "HM",
    "name": "听到岛和麦当劳的岛屿",
    "phoneCode": "0"
  },
  {
    "code": "VA",
    "name": "教廷(梵蒂冈)",
    "phoneCode": "39"
  },
  {
    "code": "HN",
    "name": "洪都拉斯",
    "phoneCode": "504"
  },
  {
    "code": "HK",
    "name": "中国香港",
    "phoneCode": "852"
  },
  {
    "code": "HU",
    "name": "匈牙利",
    "phoneCode": "36"
  },
  {
    "code": "IS",
    "name": "冰岛",
    "phoneCode": "354"
  },
  {
    "code": "IN",
    "name": "印度",
    "phoneCode": "91"
  },
  {
    "code": "ID",
    "name": "印尼",
    "phoneCode": "62"
  },
  {
    "code": "IR",
    "name": "伊朗伊斯兰共和国",
    "phoneCode": "98"
  },
  {
    "code": "IQ",
    "name": "伊拉克",
    "phoneCode": "964"
  },
  {
    "code": "IE",
    "name": "爱尔兰",
    "phoneCode": "353"
  },
  {
    "code": "IL",
    "name": "以色列",
    "phoneCode": "972"
  },
  {
    "code": "IT",
    "name": "意大利",
    "phoneCode": "39"
  },
  {
    "code": "JM",
    "name": "牙买加",
    "phoneCode": "1876"
  },
  {
    "code": "JP",
    "name": "日本",
    "phoneCode": "81"
  },
  {
    "code": "JO",
    "name": "约旦",
    "phoneCode": "962"
  },
  {
    "code": "KZ",
    "name": "哈萨克斯坦",
    "phoneCode": "7"
  },
  {
    "code": "KE",
    "name": "肯尼亚",
    "phoneCode": "254"
  },
  {
    "code": "KI",
    "name": "基里巴斯",
    "phoneCode": "686"
  },
  {
    "code": "KP",
    "name": "朝鲜民主主义人民共和国",
    "phoneCode": "850"
  },
  {
    "code": "KR",
    "name": "韩国",
    "phoneCode": "82"
  },
  {
    "code": "KW",
    "name": "科威特",
    "phoneCode": "965"
  },
  {
    "code": "KG",
    "name": "吉尔吉斯斯坦",
    "phoneCode": "996"
  },
  {
    "code": "LA",
    "name": "老挝人民民主共和国",
    "phoneCode": "856"
  },
  {
    "code": "LV",
    "name": "拉脱维亚",
    "phoneCode": "371"
  },
  {
    "code": "LB",
    "name": "黎巴嫩",
    "phoneCode": "961"
  },
  {
    "code": "LS",
    "name": "莱索托",
    "phoneCode": "266"
  },
  {
    "code": "LR",
    "name": "利比里亚",
    "phoneCode": "231"
  },
  {
    "code": "LY",
    "name": "阿拉伯利比亚民众国",
    "phoneCode": "218"
  },
  {
    "code": "LI",
    "name": "列支敦斯登",
    "phoneCode": "423"
  },
  {
    "code": "LT",
    "name": "立陶宛",
    "phoneCode": "370"
  },
  {
    "code": "LU",
    "name": "卢森堡",
    "phoneCode": "352"
  },
  {
    "code": "MO",
    "name": "澳门",
    "phoneCode": "853"
  },
  {
    "code": "MK",
    "name": "前南斯拉夫马其顿共和国",
    "phoneCode": "389"
  },
  {
    "code": "MG",
    "name": "马达加斯加",
    "phoneCode": "261"
  },
  {
    "code": "MW",
    "name": "马拉维",
    "phoneCode": "265"
  },
  {
    "code": "MY",
    "name": "马来西亚",
    "phoneCode": "60"
  },
  {
    "code": "MV",
    "name": "马尔代夫",
    "phoneCode": "960"
  },
  {
    "code": "ML",
    "name": "马里",
    "phoneCode": "223"
  },
  {
    "code": "MT",
    "name": "马耳他",
    "phoneCode": "356"
  },
  {
    "code": "MH",
    "name": "马绍尔群岛",
    "phoneCode": "692"
  },
  {
    "code": "MQ",
    "name": "马提尼克岛",
    "phoneCode": "596"
  },
  {
    "code": "MR",
    "name": "毛利塔尼亚",
    "phoneCode": "222"
  },
  {
    "code": "MU",
    "name": "毛里求斯",
    "phoneCode": "230"
  },
  {
    "code": "YT",
    "name": "马约特岛",
    "phoneCode": "269"
  },
  {
    "code": "MX",
    "name": "墨西哥",
    "phoneCode": "52"
  },
  {
    "code": "FM",
    "name": "密克罗尼西亚联邦",
    "phoneCode": "691"
  },
  {
    "code": "MD",
    "name": "摩尔多瓦共和国",
    "phoneCode": "373"
  },
  {
    "code": "MC",
    "name": "摩纳哥",
    "phoneCode": "377"
  },
  {
    "code": "MN",
    "name": "蒙古",
    "phoneCode": "976"
  },
  {
    "code": "MS",
    "name": "蒙特塞拉特",
    "phoneCode": "1664"
  },
  {
    "code": "MA",
    "name": "摩洛哥",
    "phoneCode": "212"
  },
  {
    "code": "MZ",
    "name": "MOZAMBIQUE",
    "phoneCode": "258"
  },
  {
    "code": "MM",
    "name": "缅甸",
    "phoneCode": "95"
  },
  {
    "code": "NA",
    "name": "纳米比亚",
    "phoneCode": "264"
  },
  {
    "code": "NR",
    "name": "瑙鲁",
    "phoneCode": "674"
  },
  {
    "code": "NP",
    "name": "尼泊尔",
    "phoneCode": "977"
  },
  {
    "code": "NL",
    "name": "荷兰",
    "phoneCode": "31"
  },
  {
    "code": "AN",
    "name": "荷属安的列斯群岛",
    "phoneCode": "599"
  },
  {
    "code": "NC",
    "name": "新喀里多尼亚",
    "phoneCode": "687"
  },
  {
    "code": "NZ",
    "name": "新西兰",
    "phoneCode": "64"
  },
  {
    "code": "NI",
    "name": "尼加拉瓜",
    "phoneCode": "505"
  },
  {
    "code": "NE",
    "name": "尼日尔",
    "phoneCode": "227"
  },
  {
    "code": "NG",
    "name": "尼日利亚",
    "phoneCode": "234"
  },
  {
    "code": "NU",
    "name": "纽埃岛",
    "phoneCode": "683"
  },
  {
    "code": "NF",
    "name": "诺福克岛",
    "phoneCode": "672"
  },
  {
    "code": "MP",
    "name": "北马里亚纳群岛",
    "phoneCode": "1670"
  },
  {
    "code": "NO",
    "name": "挪威",
    "phoneCode": "47"
  },
  {
    "code": "OM",
    "name": "阿曼",
    "phoneCode": "968"
  },
  {
    "code": "PK",
    "name": "巴基斯坦",
    "phoneCode": "92"
  },
  {
    "code": "PW",
    "name": "帕劳",
    "phoneCode": "680"
  },
  {
    "code": "PS",
    "name": "巴勒斯坦的领土,占领",
    "phoneCode": "970"
  },
  {
    "code": "PA",
    "name": "巴拿马",
    "phoneCode": "507"
  },
  {
    "code": "PG",
    "name": "巴布新几内亚",
    "phoneCode": "675"
  },
  {
    "code": "PY",
    "name": "巴拉圭",
    "phoneCode": "595"
  },
  {
    "code": "PE",
    "name": "秘鲁",
    "phoneCode": "51"
  },
  {
    "code": "PH",
    "name": "菲律宾",
    "phoneCode": "63"
  },
  {
    "code": "PN",
    "name": "皮特克恩",
    "phoneCode": "0"
  },
  {
    "code": "PL",
    "name": "波兰",
    "phoneCode": "48"
  },
  {
    "code": "PT",
    "name": "葡萄牙",
    "phoneCode": "351"
  },
  {
    "code": "PR",
    "name": "波多黎各",
    "phoneCode": "1787"
  },
  {
    "code": "QA",
    "name": "卡塔尔",
    "phoneCode": "974"
  },
  {
    "code": "RE",
    "name": "团聚",
    "phoneCode": "262"
  },
  {
    "code": "RO",
    "name": "罗马尼亚",
    "phoneCode": "40"
  },
  {
    "code": "RU",
    "name": "俄罗斯联邦",
    "phoneCode": "70"
  },
  {
    "code": "RW",
    "name": "卢旺达",
    "phoneCode": "250"
  },
  {
    "code": "SH",
    "name": "圣赫勒拿",
    "phoneCode": "290"
  },
  {
    "code": "KN",
    "name": "圣基茨和尼维斯",
    "phoneCode": "1869"
  },
  {
    "code": "LC",
    "name": "圣卢西亚岛",
    "phoneCode": "1758"
  },
  {
    "code": "PM",
    "name": "圣皮埃尔和MIQUELON",
    "phoneCode": "508"
  },
  {
    "code": "VC",
    "name": "圣文森特和格林纳丁斯",
    "phoneCode": "1784"
  },
  {
    "code": "WS",
    "name": "萨摩亚",
    "phoneCode": "684"
  },
  {
    "code": "SM",
    "name": "圣马力诺",
    "phoneCode": "378"
  },
  {
    "code": "ST",
    "name": "圣多美和王子",
    "phoneCode": "239"
  },
  {
    "code": "SA",
    "name": "沙特阿拉伯",
    "phoneCode": "966"
  },
  {
    "code": "SN",
    "name": "塞内加尔",
    "phoneCode": "221"
  },
  {
    "code": "CS",
    "name": "塞尔维亚和黑山",
    "phoneCode": "381"
  },
  {
    "code": "SC",
    "name": "塞舌尔",
    "phoneCode": "248"
  },
  {
    "code": "SL",
    "name": "塞拉利昂",
    "phoneCode": "232"
  },
  {
    "code": "SG",
    "name": "新加坡",
    "phoneCode": "65"
  },
  {
    "code": "SK",
    "name": "斯洛伐克",
    "phoneCode": "421"
  },
  {
    "code": "SI",
    "name": "斯洛文尼亚",
    "phoneCode": "386"
  },
  {
    "code": "SB",
    "name": "所罗门群岛",
    "phoneCode": "677"
  },
  {
    "code": "SO",
    "name": "索马里",
    "phoneCode": "252"
  },
  {
    "code": "ZA",
    "name": "南非",
    "phoneCode": "27"
  },
  {
    "code": "GS",
    "name": "南乔治亚岛和南桑威奇群岛",
    "phoneCode": "0"
  },
  {
    "code": "ES",
    "name": "西班牙",
    "phoneCode": "34"
  },
  {
    "code": "LK",
    "name": "斯里兰卡",
    "phoneCode": "94"
  },
  {
    "code": "SD",
    "name": "苏丹",
    "phoneCode": "249"
  },
  {
    "code": "SR",
    "name": "苏里南",
    "phoneCode": "597"
  },
  {
    "code": "SJ",
    "name": "斯瓦尔巴群岛和扬马延岛",
    "phoneCode": "47"
  },
  {
    "code": "SZ",
    "name": "斯威士兰",
    "phoneCode": "268"
  },
  {
    "code": "SE",
    "name": "瑞典",
    "phoneCode": "46"
  },
  {
    "code": "CH",
    "name": "瑞士",
    "phoneCode": "41"
  },
  {
    "code": "SY",
    "name": "阿拉伯叙利亚共和国",
    "phoneCode": "963"
  },
  {
    "code": "TW",
    "name": "中国台湾",
    "phoneCode": "886"
  },
  {
    "code": "TJ",
    "name": "塔吉克斯坦",
    "phoneCode": "992"
  },
  {
    "code": "TZ",
    "name": "坦桑尼亚联合共和国",
    "phoneCode": "255"
  },
  {
    "code": "TH",
    "name": "泰国",
    "phoneCode": "66"
  },
  {
    "code": "TL",
    "name": "东帝汶",
    "phoneCode": "670"
  },
  {
    "code": "TG",
    "name": "多哥",
    "phoneCode": "228"
  },
  {
    "code": "TK",
    "name": "托克劳",
    "phoneCode": "690"
  },
  {
    "code": "TO",
    "name": "汤加",
    "phoneCode": "676"
  },
  {
    "code": "TT",
    "name": "特立尼达和多巴哥",
    "phoneCode": "1868"
  },
  {
    "code": "TN",
    "name": "突尼斯",
    "phoneCode": "216"
  },
  {
    "code": "TR",
    "name": "土耳其",
    "phoneCode": "90"
  },
  {
    "code": "TM",
    "name": "土库曼斯坦",
    "phoneCode": "7370"
  },
  {
    "code": "TC",
    "name": "特克斯和凯科斯群岛",
    "phoneCode": "1649"
  },
  {
    "code": "TV",
    "name": "图瓦卢",
    "phoneCode": "688"
  },
  {
    "code": "UG",
    "name": "乌干达",
    "phoneCode": "256"
  },
  {
    "code": "UA",
    "name": "乌克兰",
    "phoneCode": "380"
  },
  {
    "code": "AE",
    "name": "阿拉伯联合酋长国",
    "phoneCode": "971"
  },
  {
    "code": "GB",
    "name": "联合王国",
    "phoneCode": "44"
  },
  {
    "code": "US",
    "name": "美国",
    "phoneCode": "1"
  },
  {
    "code": "UM",
    "name": "美国小离岛",
    "phoneCode": "1"
  },
  {
    "code": "UY",
    "name": "乌拉圭",
    "phoneCode": "598"
  },
  {
    "code": "UZ",
    "name": "乌兹别克斯坦",
    "phoneCode": "998"
  },
  {
    "code": "VU",
    "name": "瓦努阿图",
    "phoneCode": "678"
  },
  {
    "code": "VE",
    "name": "委内瑞拉",
    "phoneCode": "58"
  },
  {
    "code": "VN",
    "name": "越南",
    "phoneCode": "84"
  },
  {
    "code": "VG",
    "name": "维尔京群岛,英国",
    "phoneCode": "1284"
  },
  {
    "code": "VI",
    "name": "维尔京群岛,美国",
    "phoneCode": "1340"
  },
  {
    "code": "WF",
    "name": "瓦利斯群岛和富图纳群岛",
    "phoneCode": "681"
  },
  {
    "code": "EH",
    "name": "西撒哈拉",
    "phoneCode": "212"
  },
  {
    "code": "YE",
    "name": "也门",
    "phoneCode": "967"
  },
  {
    "code": "ZM",
    "name": "赞比亚",
    "phoneCode": "260"
  },
  {
    "code": "ZW",
    "name": "津巴布韦",
    "phoneCode": "263"
  }
];
