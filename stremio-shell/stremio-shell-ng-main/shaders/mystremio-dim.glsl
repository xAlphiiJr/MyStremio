//!PARAM mystremio_dim
//!DESC Linear picture dim (1 = full, 0 = black)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0

//!HOOK MAIN
//!BIND HOOKED
//!DESC MyStremio linear dim

vec4 hook() {
    vec4 color = HOOKED_tex(HOOKED_pos);
    color.rgb *= mystremio_dim;
    return color;
}
