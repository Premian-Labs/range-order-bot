FROM oven/bun
RUN apt-get update
RUN apt-get -y install curl unzip
RUN curl -fsSL https://bun.sh/install | bash
ENV HOME=/root
ENV BUN_INSTALL=${HOME}/.bun
ENV PATH=${BUN_INSTALL}/bin:$PATH
WORKDIR /
COPY . .
RUN bun install
EXPOSE 3000
ENTRYPOINT ["bun", "src/index.ts"]