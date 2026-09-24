export function privateAddresses(interfaces) {
  return networkAddresses(interfaces).all;
}

export function networkAddresses(interfaces) {
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateAddress(entry.address)) continue;
      addresses.push({
        address: entry.address,
        interfaceName,
        isTailscale: isTailscaleAddress(entry.address, interfaceName)
      });
    }
  }
  const sorted = addresses.sort((left, right) => addressPriority(left) - addressPriority(right));
  return {
    tailscale: sorted.filter(entry => entry.isTailscale).map(entry => entry.address),
    lan: sorted.filter(entry => !entry.isTailscale && isLANAddress(entry.address)).map(entry => entry.address),
    all: sorted.map(entry => entry.address)
  };
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
  return isLANAddress(address)
    || isTailscaleIPv4(address)
    || address.startsWith("100.");
}

function isLANAddress(address) {
  return address.startsWith("10.")
    || address.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function isTailscaleAddress(address, interfaceName) {
  const name = String(interfaceName).toLowerCase();
  return /^tailscale/.test(name) || (isTailscaleIPv4(address) && /^(utun|wg|tun|tailscale)/.test(name));
}

function isTailscaleIPv4(address) {
  const octets = String(address).split(".").map(Number);
  return octets.length === 4
    && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}
