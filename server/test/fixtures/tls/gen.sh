#!/bin/sh
# TEST certificates of checks.test.js and tls-pinning.test.js, generated at EACH
# test run by tls-fixtures.js in a temporary folder (no private key in the repository). Valid
# for 50 years; the CA keys are not kept. CAs A and B, leaves A (IP:127.0.0.1) and B (localhost,
# 127.0.0.1, ::1), leaf A without an IP in its SAN, expired CA (2000-2001).
#   sh gen.sh <output folder>
set -eu
[ $# -eq 1 ] || { echo "usage : $0 <dossier de sortie>" >&2; exit 2; }
cd "$1"
T=$(mktemp -d)
D=18262
mkdir -p pki
ec() { openssl ecparam -name prime256v1 -genkey -noout -out "$1"; }
ca() { # $1 name, $2 CN, then date options
  ec "$T/$1.key"; n=$1 cn=$2; shift 2
  openssl req -x509 -new -key "$T/$n.key" -subj "/CN=$cn/O=vigie tests" "$@" \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "pki/$n.pem"
}
leaf() { # $1 name, $2 CA, $3 CN, $4 SAN
  ec "$1.key"
  openssl req -new -key "$1.key" -subj "/CN=$3" -out "$T/$1.csr"
  printf 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$4" > "$T/$1.ext"
  openssl x509 -req -in "$T/$1.csr" -CA "pki/$2.pem" -CAkey "$T/$2.key" -CAserial "$T/$2.srl" -CAcreateserial -days $D -extfile "$T/$1.ext" -out "$1.pem"
}
ca ca-a 'Test CA A' -days $D
ca ca-b 'Test CA B' -days $D
# expired CA: `openssl ca -selfsign` with -startdate/-enddate, available since OpenSSL 1.x
# (`req -not_before/-not_after` only exists from 3.4: missing from the Ubuntu 24.04 CI image)
ca_expired() {
  ec "$T/ca-expired.key"
  openssl req -new -key "$T/ca-expired.key" -subj "/CN=Test CA expired/O=vigie tests" -out "$T/ca-expired.csr"
  mkdir "$T/db"; : > "$T/db/index.txt"; echo 01 > "$T/db/serial"
  cat > "$T/ca.cnf" <<EOF
[ca]
default_ca = d
[d]
database = $T/db/index.txt
serial = $T/db/serial
new_certs_dir = $T/db
default_md = sha256
policy = p
unique_subject = no
x509_extensions = ext
[p]
commonName = supplied
organizationName = optional
[ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
  openssl ca -batch -notext -config "$T/ca.cnf" -selfsign -keyfile "$T/ca-expired.key" -in "$T/ca-expired.csr" \
    -startdate 20000101000000Z -enddate 20010101000000Z -out pki/ca-expired.pem 2> "$T/ca.err" || { cat "$T/ca.err" >&2; exit 1; }
}
ca_expired
leaf leaf-a ca-a 127.0.0.1 'IP:127.0.0.1'
leaf leaf-a-nosan ca-a 127.0.0.1 'DNS:example.test'
leaf leaf-b ca-b localhost 'DNS:localhost,IP:127.0.0.1,IP:::1'
rm -rf "$T"
