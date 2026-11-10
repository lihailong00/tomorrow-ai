import { privateValueKinds, privateValueTypes, validPrivateValue, type VaultRecord } from '../../domain/privateVault';

const addressLabels = [
  { alias: '家庭住址', name: /我的(?:住址|家庭(?:住址|地址))|我家的?(?:地址|住址)/, declaration: /^(?:(?:我的(?:住址|家庭(?:住址|地址))|我家的?(?:地址|住址))(?:是|为|在|[：:])|我(?:家)?住在|我家在)/ },
  { alias: '公司地址', name: /我的(?:公司|工作)地址|我公司的地址/, declaration: /^(?:我的(?:公司|工作)地址|我公司的地址)(?:是|为|在|[：:])/ },
  { alias: '收货地址', name: /我的(?:收货|收件|配送)地址/, declaration: /^我的(?:收货|收件|配送)地址(?:是|为|在|[：:])/ },
];

const unrelated = /[？?；;\r\n]|例如|举例|假设|比方说|如果|是不是|不要记|别记|不用记|不保存|不要保存|别保存|不用保存|验证码|校验码|动态码|密码|口令|安全码|\b(?:PIN|CVV|CVC)\b|这次|这单|临时|["“”「」]/i;
const placeMarker = /省|市|区|县|镇|村|路|街|巷|号|小区|花园|公寓|大厦|地铁站|园区|广场/;
const addressTask = /酒店|宾馆|民宿|朋友的|同事的|别人的|客户的|(?:帮我|给我|请)(?:寄|送|导航|叫车|打车)|[，,。].*(?:给我|叫车|打车|导航|寄到|送到|怎么|多少钱|去哪里|出发|身份证|银行卡|手机号|邮箱|护照|驾驶证)/;
const savePrefix = /^(?:(?:请你?|麻烦你?|帮我)\s*)*(?:保存|记下(?:来)?|记住|记一下)(?:一下)?[：:，,\s]*/;
const saveSuffix = /[，,。\s]+(?:(?:请你?|麻烦你?|帮我)\s*)*(?:保存|记下(?:来)?|记住|记一下)(?:一下)?吧?$/;
const saveBinding = /^把\s*(.+?)\s*(?:保存|记下(?:来)?|记住|设)(?:为|成)\s*(.+)$/;
const opening = /^(?:(?:哎|嗯|对了|你好|要不我给你说吧)[，,\s]+)+/;
const emailTarget = new RegExp(`^(?:我的|我本人的|本人(?:的)?)(?:${privateValueKinds.email.terms.source})$`, 'i');
const valueDeclarations = privateValueTypes.map(type => ({
  type, match: new RegExp(`^(?:我的|我本人的|本人(?:的)?)(?:${privateValueKinds[type].terms.source})(?:是|为|[：:])\\s*(.+)$`, 'i'),
}));

/** Parse one owned value locally before a message can be sent to the model. */
export function detectPrivateRecord(input: string, profileName: string): VaultRecord | null {
  if (input.length > 560 || unrelated.test(input)) return null;
  const statement = input.trim().replace(opening, '').replace(/[。.!！]+$/, '').trim();
  const prefix = savePrefix.test(statement);
  const suffix = saveSuffix.test(statement);
  const explicit = prefix || suffix;
  const text = statement.replace(savePrefix, '').replace(saveSuffix, '').trim();
  const owner = profileName.trim().slice(0, 120);
  const binding = saveBinding.exec(text.replace(/^(?:请你?|帮我|麻烦你?)\s*/, ''));
  for (const { alias, name, declaration } of addressLabels) {
    const match = explicit && declaration.exec(text);
    const targetMatches = binding && new RegExp(`^(?:${name.source})$`).test(binding[2]);
    if (!match && !targetMatches) continue;
    const address = (match ? text.slice(match[0].length) : binding?.[1] ?? '').trim();
    if (targetMatches && /^(?:这|那)(?:个|里|一处)?(?:地址|住址|位置)?$/.test(address)) {
      return { type: 'address', alias, fields: { owner, address: '' } };
    }
    if (address.length < 4 || address.length > 500 || !placeMarker.test(address) || addressTask.test(address)) return null;
    return { type: 'address', alias, fields: { owner, address } };
  }
  if (binding && emailTarget.test(binding[2])) {
    const number = binding[1].trim().normalize('NFKC');
    return validPrivateValue('email', number) ? { type: 'email', alias: '我的个人邮箱', fields: { owner, number } } : null;
  }

  const normalized = text.normalize('NFKC');
  const identity = /^(?:我的|本人(?:的)?)\s*(?:居民)?身份证(?:号码|号)?(?:是|为|:)\s*(\d{17}[\dxX])$/.exec(normalized);
  if (identity) return { type: 'identity', alias: '我的身份证', fields: { owner, number: identity[1].toUpperCase() } };

  const bank = /^(?:我的|本人(?:的)?)\s*(?:([\p{Script=Han}]{2,24}银行)(?:的)?(?:银行)?卡|银行卡)(?:号码|号)?(?:是|为|:)\s*([0-9][0-9 -]{10,32}[0-9])$/u.exec(normalized);
  if (bank) {
    const number = bank[2].replace(/[ -]/g, '');
    if (/^\d{12,25}$/.test(number)) return { type: 'bank', alias: '我的银行卡', fields: { owner, bank: bank[1] ?? '', number } };
  }

  for (const { type, match } of valueDeclarations) {
    const value = match.exec(normalized)?.[1].trim();
    if (!value || (type === 'email' && !explicit)) continue;
    const number = type === 'phone' ? value.replace(/[ -]/g, '') : value;
    if (validPrivateValue(type, number)) {
      return { type, alias: type === 'phone' ? '本人手机号' : `我的${privateValueKinds[type].label}`, fields: { owner, number } };
    }
  }
  return null;
}
