export function privateAddresses(interfaces) {
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateAddress(entry.address)) continue;
      addresses.push({ address: entry.address, interfaceName });
    }
  }
  return addresses
    .sort((left, right) => addressPriority(left) - addressPriority(right))
    .map(entry => entry.address);
}

function addressPriority({ address, interfaceName }) {
  const name = String(interfaceName).toLowerCase();
  const virtual = /^(bridge|docker|veth|vmnet|vbox|virbr|awdl|llw|tap)/.test(name);
  if (virtual) return 5;
  if (/^(en\d+|eth\d+|enp|eno|ens|wlan|wifi|wi-fi|ethernet)/.test(name) && !address.startsWith("100.")) return 0;
  if (address.startsWith("100.")) return 2;
  return 1;
}

function isPrivateAddress(address) {
  return address.startsWith("10.")
    || address.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || address.startsWith("100.");
}
