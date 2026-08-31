FROM docker.io/nginxinc/nginx-unprivileged:stable-alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY ./nginx/ /etc/nginx/conf.d/
COPY ./build/ /usr/share/nginx/html/app/
EXPOSE 3000
