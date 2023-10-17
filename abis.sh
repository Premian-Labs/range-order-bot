# HTTPs cloner with Personal Access Token auth scheme
export GREEN='\033[0;32m'
rm -rf ./abi && git clone https://github.com/Premian-Labs/v3-abi.git ./temp
mkdir abi
cd temp && mv -v ./abi/* ../abi && cd .. && rm -rf temp
echo "${GREEN}ABIs cloned successfully"