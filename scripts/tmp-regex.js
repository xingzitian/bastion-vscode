const mk = '__BASTION_DONE_abc__'
const esc = mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hay = 'building\n' + mk + ':0\n'
const re = new RegExp(esc + ':(\\d+)')
console.log('esc=', JSON.stringify(esc), ' re=', String(re), ' match=', re.exec(hay))
